# Code Review Findings

Findings from the codebase review on **2026-07-01**. Each item is classified **Fixed**,
**Deferred**, or **False positive / not a bug**. Deferred items are the backlog for further work.

Methodology: four parallel subsystem reviews (kernel, sketch/solver, drawing, app-state/persistence)
plus a focused loop-detection audit, with every finding independently verified against the source
before action. Severity: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low.

---

## ✅ Fixed

| # | Sev | Area | Problem → Fix | Files |
|---|-----|------|---------------|-------|
| F1 | 🔴 | Export | **STL export always failed** ("No geometry to export"): `useCadStore.meshes` was only ever set to `[]` by the placeholder worker; real geometry lived in local viewport state. → Mirror the viewport's `SolidMeshData` into the store via `setMeshes`; stop the worker clobbering it. | `Viewport3D.tsx`, `useCadStore.ts`, `cadWorker.ts` |
| F2 | 🟠 | State | **Feature-id collisions**: ids were `` `f${Date.now()}` `` — two features created in the same ms shared an id, corrupting dimension keys and cross-feature refs. → `createFeatureId()` (UUID). | `PropertyManager.tsx`, `useCadStore.ts` |
| F3 | 🟠 | State | **Deleting a feature corrupted the model**: a deleted sketch/solid left dependents (extrude/fillet) with dangling refs → kernel throws → `CADSolids` blanks *all* geometry. → `deleteFeature` cascade-deletes dependents and cleans hidden-geometry ids; UI confirms first. | `useCadStore.ts`, `FeatureTree.tsx` |
| F4 | 🟠 | Persistence | **Silent data loss**: every `localStorage.setItem` was unguarded; quota-exceeded threw and lost the doc (autosave included) with no feedback. → `safeSetItem` + typed `StorageWriteError` + throttled `notifyStorageError` across all save paths. | `documentStore.ts`, `App.tsx` |
| F5 | 🟠 | Rendering | **GPU memory leak**: per-face `BufferGeometry` and sketch-fill `ShapeGeometry` were recreated every rebuild and never disposed → VRAM climb → WebGL context loss. → dispose-on-change effects. | `Viewport3D.tsx` |
| F6 | 🟡 | Sketch | **DoF probe regression** (uncommitted rewrite): dropped the solver-success gate, so failed/non-converged solves fed the constraint-status coloring. → restore `if (!solved.success) return undefined`. | `sketchDoF.ts` |
| F7 | ⚪ | State | Store + first history commit aliased the module-level `initialFeatures` (shared-mutable footgun). → clone at both sites. | `useCadStore.ts` |
| F8 | ⚪ | Cleanliness | 19 debug `console.log` statements in production paths. → removed (kept `warn`/`error`). | 6 files |
| F9 | ⚪ | Tooling | Lint had 12 errors + 5 warnings. → **0/0**: real fix for a ref-write-during-render; documented suppressions for false positives (three.js camera mutation, self-removing listeners) and intentional dialog-init effects. | drawing components, `App.tsx` |

## ⏳ Deferred (backlog — reasons matter)

Not fixed on purpose: each needs runtime verification of the WASM kernel/solver, or is a larger
design change. Changing them blind risked a worse regression (kernel crash, or flipping geometry).

| # | Sev | Item | Why deferred / how to approach |
|---|-----|------|-------------------------------|
| D1 | 🟠 | **STEP / DWG / SVG export are placeholders** (`App.tsx` `handleExportStep`/`handleExportDrawing`) — they emit stub text with embedded JSON, not real files. README oversells them. | Implement real exporters (OCCT STEP writer; a DXF/SVG vector emitter from projected edges). STL export is genuine. |
| D2 | 🟠 | **OpenCASCADE shape leaks** in `cadEngine.ts`: intermediate shapes (sketches, fuse/cut originals, `Plane`s, alt cut tools) aren't `.delete()`'d except in `sketchToRevolveSolids`. Accumulates per rebuild. | Mirror the `finally { fc?.delete(); sk?.delete(); }` pattern; verify each shape is unreferenced before freeing (use-after-free = crash). Runtime-test heavily. |
| D3 | 🟡 | **H/V-distance sign flip**: `useSketchStore` stores `Math.abs(Δ)` but the planegcs `difference` constraint is signed → right-to-left point selection flips geometry. | Store the signed default *or* order `entityIds` by coordinate. Requires confirming planegcs's `difference` sign convention (compiled into `planegcs.wasm`) at runtime first. |
| D4 | 🟡 | **Silent feature failure**: kernel catches build errors with `console.warn` and drops/keeps geometry with no per-feature error state; the tree and 3D result disagree. | Return per-feature success/failure from `buildAllSolids`; flag failed nodes in `FeatureTree`; stop one bad feature blanking everything. |
| D5 | 🟡 | **Fillet/chamfer edge refs are geometric snapshots** (midpoint/bbox), re-matched with scale-sensitive tolerances → upstream edits can mis-resolve or silently drop the blend. | Adopt stable topological edge naming; short-term, scale the fallback tolerance and surface "ref lost". |
| D6 | 🟡 | **Per-view WebGL contexts** (drawings): each placed view mounts its own `<Canvas>` with `preserveDrawingBuffer` → ~16 views hits the browser context cap → views go black. | Share one `<Canvas>` with scissored viewports, or virtualize; drop `preserveDrawingBuffer` except during export. |
| D7 | ⚪ | **HomePage thumbnails** rebuild every recent part's solids synchronously on the main thread, unbounded → UI jank with many recents. | Bound concurrency / cache a rendered thumbnail data-URL in the index. |
| D8 | ⚪ | **`getFeatureDependencyIds` gaps**: some face/edge refs (axis `twoPlanes`, point↔edge, plane-from-face) aren't in the dependency graph → enable/disable cascade is incomplete. | Extend `getFeatureDependencyIds` to include those `featureId`s. |
| D9 | ⚪ | **Autosave reads live store state** in a debounced timer bound to a possibly-stale `meta`; a document switch mid-debounce could theoretically write under the wrong key. | Snapshot the payload at schedule time, or make meta+features updates atomic. |
| D10 | ⚪ | **Dead solver code** (`constraintSolver.ts`, `assemble2d/`) kept only for re-exported interfaces. | Relocate the shared TS interfaces, then delete (~1.5k LOC). |
| D11 | ⚪ | Shared module-global `_geoSelectionCb` picking callback can be clobbered if two geometric-input activations overlap. | Key the callback by field name / store it in Zustand alongside `activeInputField`. |

## 🔎 Investigated — not a bug

- **Loop detection at reflex/concave vertices** — an isolated read of `pickNextEdgeInFace` suggested
  the reversal edge (`d = π`) would beat right-turn continuations, breaking L-shapes. Verified against
  the **caller** (`findClosedMixedLoops`, `cadEngine.ts`): it filters neighbors by `!thisUsed.has(edgeId)`,
  and the incoming edge is always in `thisUsed`, so the reversal is never a candidate. Degree-2 vertices
  short-circuit via `nbrs.length === 1`. L-shapes trace correctly. **Left untouched.**
- **`react-hooks/immutability` errors** on `DrawingOrthoPreview` (camera frustum mutation) and
  `DrawingSheet` (self-referencing `useCallback`) are **false positives** — idiomatic three.js/React.
  Suppressed with rationale, not "fixed".
- Kernel unit conventions (`revolution` uses degrees; XZ plane-offset sign) and the sketch-plane basis,
  B-spline knots, arc sweep, and loop winding were checked and are correct.

## Verification status

`npm run build` ✅ (0 type errors) · `npm run lint` ✅ (0 problems) · dev server boots, Home + Part
editor mount with no console errors. The **kernel/solver deferred items (D2, D3) still need
interactive runtime testing** before anyone attempts them.
