# Changelog

All notable changes to **3dcad** are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/); this project is pre-1.0 and
unversioned, so changes are grouped under **Unreleased** until a release scheme is adopted.

## [Unreleased]

### Fixed
- **STL export produced nothing.** The store's `meshes` were never populated (the Web Worker is a
  placeholder that returns empty meshes; real geometry lived only in viewport-local state). The
  viewport now mirrors its built solids into the store, so "Export STL" works.
- **Feature-id collisions.** New features used `` `f${Date.now()}` `` and could collide within a
  millisecond, corrupting dimension keys and cross-feature references. Now UUID-based via
  `createFeatureId()`.
- **Model corruption on delete.** Deleting a feature that others depended on (e.g. a sketch under an
  extrude, or an extrude under a fillet) left dangling references that threw during rebuild and
  blanked the *entire* model. `deleteFeature` now cascade-deletes dependents (with a confirmation
  dialog) and removes their stale hidden-geometry ids.
- **Silent data loss on save.** `localStorage` writes were unguarded; hitting quota threw and lost
  the document with no feedback, including during autosave. Writes now go through a guarded
  `safeSetItem` that raises a typed `StorageWriteError`, surfaced to the user (throttled).
- **GPU memory leak.** Per-face `BufferGeometry` and sketch-fill `ShapeGeometry` were recreated on
  every rebuild and never disposed, leaking VRAM until context loss. Added disposal effects.
- **Degrees-of-freedom mis-coloring.** The DoF probe accepted coordinates from failed/non-converged
  constraint solves; restored the solver-success gate so entity coloring reflects real state.
- **Shared-mutable seed data.** The store and its initial history commit aliased the module-level
  `initialFeatures`; both now clone it.

### Changed
- Removed 19 debug `console.log` statements from production code paths (kept `console.warn` /
  `console.error` for genuine failures).
- ESLint is clean (**0 errors, 0 warnings**, down from 12 errors + 5 warnings): a real fix for a
  ref-write-during-render, plus documented suppressions for confirmed false positives (three.js
  camera mutation, self-removing listeners) and intentional dialog-init effects.

### Added
- Contributor/agent documentation: [`AGENTS.md`](AGENTS.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
  [`docs/CODE_REVIEW_FINDINGS.md`](docs/CODE_REVIEW_FINDINGS.md), and this changelog.
- `.claude/launch.json` dev-server config (enables the preview/verify tooling).

### Known issues / not yet addressed
Tracked in [`docs/CODE_REVIEW_FINDINGS.md`](docs/CODE_REVIEW_FINDINGS.md) (Deferred). Highlights:
STEP/DWG/SVG exports are still placeholders; OpenCASCADE intermediate shapes leak WASM memory;
horizontal/vertical-distance dimensions can flip geometry on right-to-left selection; drawings mount
one WebGL context per view.

---

## Prior history (from git)

- `0881b12` migrated the constraint solver to **planegcs** (the previous L-BFGS solver in
  `src/core/constraintSolver.ts` / `src/core/assemble2d/` is now dead at runtime).
- `1c6a10a` drawing export options (PDF/DWG/SVG) and title-block management.
- `840b1aa` dimensioning + isometric drawing views.
- `84a9cd5` parallel-edge dimensioning.
