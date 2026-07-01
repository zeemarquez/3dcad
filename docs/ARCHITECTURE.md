# Architecture

How **3dcad** is put together: module layout, the domain data model, and the main runtime flows.
For contributor conventions and gotchas see [`../AGENTS.md`](../AGENTS.md).

---

## 1. Big picture

Everything runs client-side in the browser. There are two document types — **Part** (`.par`) and
**Drawing** (`.drw`) — persisted to `localStorage`. A Part is a **parametric feature tree** evaluated
by a B-rep kernel (replicad/OpenCASCADE, WASM) into meshes rendered with three.js. A Drawing links a
Part and projects its solids into 2D views with dimensions and a title block.

```
                       ┌─────────────────────────────────────────────┐
                       │                  App.tsx                     │
                       │   view: 'home' | 'part' | 'drawing'          │
                       │   document lifecycle + autosave (localStorage)│
                       └───────────────┬───────────────┬──────────────┘
                     part view         │               │   drawing view
             ┌──────────────────────────▼──┐        ┌───▼───────────────────────┐
             │ Part module                  │        │ Drawing module            │
             │  useCadStore (feature tree)  │        │  useDrawingStore (sheet,  │
             │  useSketchStore (active 2D)  │        │   views, dimensions)      │
             │  Viewport3D  ← buildAllSolids│        │  DrawingSheet → per-view  │
             │  Sketcher2D  ← planegcs      │        │   R3F projection + dims   │
             └──────────────────────────────┘        └───────────────────────────┘
                          │                                    │
                 ┌────────▼─────────┐                 ┌────────▼─────────┐
                 │ src/core (solver,│                 │ loadPartSolids   │
                 │ DoF, loops,      │                 │ (rebuilds linked │
                 │ plane basis)     │                 │  part's solids)  │
                 └──────────────────┘                 └──────────────────┘
```

## 2. Directory layout

```
src/
├── app/                          App shell + document persistence
│   ├── App.tsx                   Top-level view switch, autosave, export orchestration
│   ├── HomePage.tsx              Recent-documents grid; builds part thumbnails
│   └── documentStore.ts          localStorage read/write, doc index, StorageWriteError
│
├── core/                         Framework-agnostic sketch/solver logic
│   ├── planegcsConstraintBridge.ts   ★ LIVE 2D constraint solver (planegcs/WASM)
│   ├── constraintSolver.ts           ✗ DEAD at runtime — old L-BFGS solver; interfaces only
│   ├── assemble2d/                   ✗ DEAD at runtime — old solver support library
│   ├── sketchDoF.ts                  Degrees-of-freedom probe → entity coloring
│   ├── sketchLoopDetection.ts        Planar loop finding (regions for extrude/fill)
│   ├── sketchArcPoints.ts            Arc sampling / signed sweep
│   ├── sketchBspline.ts              Open-uniform B-spline (Cox–de Boor, bezier conversion)
│   ├── sketchPlaneBasis.ts           Sketch-plane ↔ world transforms (right-handed basis)
│   └── geoSelectionRef.ts            Type guards for GeometricSelectionRef
│
├── modules/
│   ├── part/
│   │   ├── kernel/
│   │   │   ├── cadEngine.ts           ★ buildAllSolids: features → replicad shapes → SolidMeshData
│   │   │   ├── cadFeatureInputs.ts    Feature[] → kernel FeatureInput[] (resolves refs)
│   │   │   ├── cadWorker.ts           ✗ placeholder worker (returns empty meshes)
│   │   │   └── axisFeatureLine.ts     Construction-axis line resolution
│   │   ├── viewport/
│   │   │   ├── viewportBrep.ts        SolidMeshData → three.js faces/edges/vertices; ref matching
│   │   │   ├── viewportConstants.ts   Tolerances, colors
│   │   │   └── partViewportMode.ts    Selection-mode state (what is pickable)
│   │   ├── components/
│   │   │   ├── Viewport3D.tsx         R3F scene: solids, previews, picking, gizmo, grid
│   │   │   ├── PropertyManager.tsx    Right panel: create/edit features (largest UI file)
│   │   │   ├── FeatureTree.tsx        Left panel: feature/geometry list, context menu
│   │   │   ├── ParametersDialog.tsx   Global + dimension parameters editor
│   │   │   ├── VersionControl.tsx     Commit/restore local history
│   │   │   └── PartThumbnailCanvas.tsx Static solid render for home cards
│   │   ├── sketch/Sketcher2D.tsx      2D sketch editor overlay (draw + constrain + dimension)
│   │   ├── store/
│   │   │   ├── useCadStore.ts         ★ feature tree, params, selection, view, history, documents
│   │   │   └── useSketchStore.ts      active-sketch geometry + constraints + solve
│   │   └── toolbar/                   TopBar, PartTools, SketchTools, ViewTools, FileToolbar
│   │
│   ├── drawing/
│   │   ├── store/useDrawingStore.ts   sheet, linked part, views, dimensions, title block
│   │   ├── components/
│   │   │   ├── DrawingEditor.tsx       shell; loads linked part solids
│   │   │   ├── DrawingSheet.tsx        paper, pan/zoom, view drag, keyboard
│   │   │   ├── DrawingOrthoPreview.tsx per-view R3F ortho projection (one <Canvas> per view)
│   │   │   ├── DrawingOrthoDimensionLayer.tsx  H/V dimensions, edge/vertex picking
│   │   │   └── … PlaceViewDialog, LinkPartDialog, TitleBlock*  (dialogs/sidebars)
│   │   ├── export/exportDrawingSheetToPdf.ts   html2canvas + jsPDF
│   │   ├── loadPartSolids.ts          rebuild a linked part's solids for projection
│   │   ├── drawingDimensionMath.ts    dimension endpoint geometry
│   │   └── titleBlock/titleBlockModel.ts  editable title-block table model
│   │
│   └── assembly/                  (stub/experimental)
│
├── App.css / index.css           Tailwind entry + globals
└── main.tsx                      React root (StrictMode)
```

★ = hot path / most important · ✗ = legacy/dead, do not extend

## 3. Domain data model

Defined in [`useCadStore.ts`](../src/modules/part/store/useCadStore.ts).

### Feature tree
`Feature` is a discriminated union on `type`:

| type | purpose | key params |
|------|---------|-----------|
| `sketch` | 2D profile on a plane | `plane`, `planeOffset`, `planeRef`, `sketchData` |
| `extrude` / `cut` | add / subtract prism from a sketch | `sketchId`, `height`/`depth`, `reverse`, `symmetric`, `startOffset` |
| `revolve` / `revolveCut` | revolve a sketch about an axis | `sketchId`, `angle`, `revolveAxis`, `startOffset` |
| `fillet` / `chamfer` | blend edges of a solid | `targetFeatureId`, `radius`/`distance`, `edges[]` |
| `plane` | reference plane | `method` (offset / threePoints), refs |
| `point` | reference point | `method` (coords / offset / intersections), refs |
| `axis` | reference axis | `method` (twoPoints / planePoint / twoPlanes), refs |

- **`GeometricSelectionRef`** is the tagged reference to picked geometry (default plane, face, edge,
  vertex, user plane/axis/point, world axis). Edge/face refs store **geometric snapshots**
  (midpoint/direction/bbox) that are re-matched to the current mesh at build time — see
  `bestMeshEdgeIdForRef` (this is why upstream parametric edits can stale a fillet ref).
- **`SketchData`** = `points`, `lines`, `circles`, `arcs`, `bsplines`, `constraints`. Points carry
  ids; everything else references point ids. `auxiliary` marks construction geometry.
- **Dependencies:** `getFeatureDependencyIds` / `collectDependentFeatureIds` drive cascade-delete
  and enable/disable propagation.

### Parameters
- `UserParameter` — named value or `=expression` (evaluated with a scoped `new Function`).
- `DimensionParameter` — auto-derived from feature/sketch dimensions; stable names (`LENGTH_1`, …);
  editing writes back into the feature/sketch via `applyValueToDimensionTarget`.

### Documents
- `PartDocumentData { kind:'part', version:1, meta, parameters, operations }`
- `DrawingDocumentData { kind:'drawing', version:1, meta, … }`
- localStorage keys: index `moderncad.docs.index.v1`, last-opened `moderncad.docs.lastOpened.v1`,
  body `moderncad.doc.<id>.v1`.

## 4. Key flows

### Part evaluation (edit → pixels)
1. UI mutates `useCadStore.features`.
2. `Viewport3D`/`CADSolids` reacts, calls `featuresToCadFeatureInputs(features)` then
   `buildAllSolids(inputs)` → `SolidMeshData[]` (vertices/normals/triangles + face groups + edges).
3. Result is rendered (`buildFacesFromMesh`/`buildEdgesFromMesh`) **and** mirrored into
   `useCadStore.meshes` via `setMeshes` for export.
4. Kernel internals: each sketch → filled region loops (`buildFilledRegionDrawings`, uses
   `sketchLoopDetection`) → replicad `Drawing` → `sketchOnPlane` → `extrude`/`revolution`; solids are
   fused/cut by AABB-overlap heuristics; fillet/chamfer match stored edge refs to mesh edges.

### Sketch solving
1. `Sketcher2D` edits `useSketchStore` geometry + constraints.
2. Solves via `solveConstraints` in `planegcsConstraintBridge.ts` (maps app constraints to planegcs
   primitives, runs DogLeg, applies solution). Returns `{ success, points, … }` — **`points` is
   always the full array; trust coordinates only when `success` is true.**
3. `sketchDoF.computeSketchDoFState` colors entities by remaining degrees of freedom (central-
   difference perturbation probes + Gram–Schmidt rank).

### Drawing projection
1. `DrawingEditor` loads the linked part's solids (`loadPartSolids`, rebuilds via the kernel).
2. `DrawingSheet` lays out views; each `DrawingOrthoPreview` renders an **orthographic R3F projection**
   in its own `<Canvas>`. Dimensions live in `DrawingOrthoDimensionLayer`.
3. Export: PDF via html2canvas+jsPDF; DWG/SVG/STEP are currently **placeholders** (see findings).

### Persistence & autosave
- `App.tsx` debounces saves (1200 ms) and flushes on `beforeunload`/visibility-hidden.
- All writes go through `documentStore` → `safeSetItem` (throws typed `StorageWriteError`, surfaced
  by a throttled `notifyStorageError`).

## 5. State stores (Zustand)

| Store | Owns |
|-------|------|
| `useCadStore` | feature tree, meshes mirror, selection, geometric-input picking, view settings, commits, parameters, part document import/export |
| `useSketchStore` | the currently-open sketch's points/lines/arcs/circles/bsplines/constraints and its solve |
| `useDrawingStore` | sheet geometry, linked part id, placed views, dimensions, title block |

## 6. Legacy / dead code

- [`src/core/constraintSolver.ts`](../src/core/constraintSolver.ts) and
  [`src/core/assemble2d/`](../src/core/assemble2d/) are the previous hand-rolled L-BFGS solver. The
  migration to planegcs (commit `0881b12`) left them importable **only for their TypeScript
  interfaces** (re-exported by the bridge). No runtime path calls them. Removing them cleanly means
  relocating those shared types first.
- [`cadWorker.ts`](../src/modules/part/kernel/cadWorker.ts) is retained for future OCCT precision
  operations but currently does no geometry work.
