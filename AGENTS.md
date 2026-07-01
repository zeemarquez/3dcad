# AGENTS.md

Guidance for AI agents and new contributors working on **3dcad**. Read this first, then
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the deep dive.

> `AGENTS.md` is the machine-facing contributor guide. Human-facing product docs live in
> [`README.md`](README.md). Design/structure details live under [`docs/`](docs/).

---

## What this is

Browser-based **parametric 3D CAD**: a feature tree, a 2D sketcher with a real constraint
solver, B-rep solids, reference geometry, global/dimension parameters, 2D drawing sheets, and
local (browser) document storage with a commit history. No backend — everything runs in the tab.

## Tech stack

- **React 19** + **TypeScript** + **Vite** (rolldown-vite)
- **@react-three/fiber** / **drei** + **three** — 3D viewport
- **replicad** + **replicad-opencascadejs** (OpenCASCADE WASM) — B-rep solid kernel
- **@salusoft89/planegcs** (FreeCAD GCS compiled to WASM) — 2D sketch constraint solver
- **Zustand** — state · **Tailwind CSS** — styling · **jsPDF** / **html2canvas** — drawing export

## Commands

```bash
npm install          # first run pulls assemble2d from GitHub — needs network
npm run dev          # Vite dev server + HMR (http://localhost:5173)
npm run build        # tsc -b && vite build  (this is the typecheck+build gate)
npm run lint         # eslint . — must be 0 errors
npm run preview      # serve dist/
```

There is **no test suite** yet. The verification gate is: **`npm run build` passes, `npm run lint`
is clean, and the app boots without console errors.** Prefer verifying real behavior in the running
app (the CAD/solver logic can't be checked by types alone).

## Conventions

- **Imports:** use the `@/` alias for `src/` (e.g. `@/modules/part/store/useCadStore`). Configured
  in both `vite.config.ts` and `tsconfig.app.json`.
- **State:** Zustand stores are the source of truth (`useCadStore`, `useSketchStore`,
  `useDrawingStore`). Reducers return **new** objects/arrays — never mutate state in place.
- **Feature ids:** always use `createFeatureId()` from `useCadStore` (UUID-based). Never
  `` `f${Date.now()}` `` — it collides within a millisecond.
- **Styling:** Tailwind utility classes inline; shared class strings are module-level consts.
- **No stray `console.log`:** keep `console.warn`/`console.error` for genuine failures only.
- **Memory:** dispose three.js `BufferGeometry`/`Material` you create imperatively (see the
  `useEffect(() => () => geo.dispose())` pattern in `Viewport3D`/`PartThumbnailCanvas`).

## Critical gotchas (read before editing the kernel)

1. **Solids are built on the main thread, client-side.** `buildAllSolids()` in
   [`cadEngine.ts`](src/modules/part/kernel/cadEngine.ts) is called from `CADSolids` in
   `Viewport3D`. The Web Worker ([`cadWorker.ts`](src/modules/part/kernel/cadWorker.ts)) is a
   **placeholder** — it returns no geometry.
2. **`useCadStore.meshes` is mirrored from the viewport** (via `setMeshes`) so exports (STL) have
   data. Do not expect the worker to populate it.
3. **planegcs is the live solver.** [`planegcsConstraintBridge.ts`](src/core/planegcsConstraintBridge.ts)
   is used everywhere. [`constraintSolver.ts`](src/core/constraintSolver.ts) and
   [`src/core/assemble2d/`](src/core/assemble2d/) are the **old L-BFGS solver — dead at runtime**
   (only interfaces are re-exported). Don't wire new logic into them.
4. **A thrown feature blanks the whole model.** `CADSolids` catches build errors and clears all
   solids. Keep per-feature failures contained; deleting a feature cascades to dependents
   (`deleteFeature`) precisely to avoid dangling refs that throw here.
5. **replicad/OCCT shapes hold WASM memory.** They must be `.delete()`'d when no longer used
   (see `sketchToRevolveSolids`). A wrong `.delete()` is a use-after-free crash — change with care
   and runtime-test. (Known leaks are tracked in the findings doc.)
6. **Persistence is localStorage** and can hit quota. All writes go through `safeSetItem` in
   [`documentStore.ts`](src/app/documentStore.ts) and surface a `StorageWriteError`; keep it that way.

## Where things live

| Area | Path |
|------|------|
| App shell, documents, home | [`src/app/`](src/app/) |
| Part module (kernel, viewport, sketcher, tools, store) | [`src/modules/part/`](src/modules/part/) |
| Drawing module (sheets, views, dimensions, export) | [`src/modules/drawing/`](src/modules/drawing/) |
| Sketch/solver core (planegcs bridge, DoF, loops, splines) | [`src/core/`](src/core/) |

Full annotated tree and data model: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Before you finish a change

1. `npm run build` — 0 type errors.
2. `npm run lint` — 0 errors (document intentional rule exceptions inline, don't blanket-disable).
3. Boot `npm run dev`, exercise the affected feature, check the browser console is clean.
4. If you changed the kernel or solver, verify **actual geometry/constraints**, not just that it compiles.

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — structure, data model, key flows
- [`docs/CODE_REVIEW_FINDINGS.md`](docs/CODE_REVIEW_FINDINGS.md) — reviewed bugs (fixed + deferred + false positives)
- [`CHANGELOG.md`](CHANGELOG.md) — history of notable changes
