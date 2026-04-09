import { create } from 'zustand';
import {
  solveConstraints,
  type SolverPoint,
  type SolverLine,
  type SolverCircle,
  type SolverArc,
  type SolverConstraint,
} from '../lib/constraintSolver';
import { sampleArcPoints } from '../lib/sketchArcPoints';
import {
  BSPLINE_DEFAULT_DEGREE,
  BSPLINE_HIT_SAMPLES_PER_SPAN,
  sampleOpenUniformBSpline,
} from '../lib/sketchBspline';

export const SKETCH_REF_ORIGIN_ID = '__ref_origin__';
export const SKETCH_REF_X_AXIS_ID = '__ref_x_axis__';
export const SKETCH_REF_Y_AXIS_ID = '__ref_y_axis__';

export interface SketchPoint {
  id: string;
  x: number;
  y: number;
}

export interface SketchLine {
  id: string;
  p1Id: string;
  p2Id: string;
  /** Construction geometry: dashed in sketch, ignored for extrude/regions. */
  auxiliary?: boolean;
}

export interface SketchCircle {
  id: string;
  centerId: string;
  radius: number;
  auxiliary?: boolean;
}

export interface SketchArc {
  id: string;
  centerId: string;
  startId: string;
  endId: string;
  /** True: longer arc between start and end; omit/false: shorter (minor) arc. */
  complementaryArc?: boolean;
  auxiliary?: boolean;
}

/** Open uniform B-spline; default degree 3 (cubic), minimum degree+1 control points. */
export interface SketchBspline {
  id: string;
  controlPointIds: string[];
  degree?: number;
  auxiliary?: boolean;
}

export type ConstraintType =
  | 'fix'
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'equal'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'concentric'
  | 'midpoint'
  | 'pointOnLine'
  | 'distance'
  | 'arcRadius'
  | 'length'
  | 'horizontalDistance'
  | 'verticalDistance'
  | 'radius'
  | 'angle'
  | 'symmetry';

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  entityIds: string[];
  params?: Record<string, number>;
  expression?: string;
}

export interface SelectionItem {
  type: 'point' | 'line' | 'circle' | 'arc' | 'bspline' | 'constraint';
  id: string;
}

export interface SketchDataSnapshot {
  points: SketchPoint[];
  lines: SketchLine[];
  circles: SketchCircle[];
  arcs: SketchArc[];
  bsplines?: SketchBspline[];
  constraints: SketchConstraint[];
}

/** Full sketch UI + geometry snapshot for undo/redo (excludes history stacks). */
export interface SketchHistorySnapshot {
  points: SketchPoint[];
  lines: SketchLine[];
  circles: SketchCircle[];
  arcs: SketchArc[];
  bsplines?: SketchBspline[];
  constraints: SketchConstraint[];
  selection: SelectionItem[];
  statusMessage: string;
  pendingDimensionInput: DimensionInputRequest | null;
  pendingConstraintType: ConstraintType | null;
}

const SKETCH_HISTORY_MAX = 100;

let applyingSketchHistory = false;

function cloneSketchHistorySnapshot(s: SketchState): SketchHistorySnapshot {
  return {
    points: structuredClone(s.points),
    lines: structuredClone(s.lines),
    circles: structuredClone(s.circles),
    arcs: structuredClone(s.arcs),
    bsplines: structuredClone(s.bsplines),
    constraints: structuredClone(s.constraints),
    selection: structuredClone(s.selection),
    statusMessage: s.statusMessage,
    pendingDimensionInput: s.pendingDimensionInput ? structuredClone(s.pendingDimensionInput) : null,
    pendingConstraintType: s.pendingConstraintType,
  };
}

export interface DimensionInputRequest {
  mode: 'create' | 'edit';
  constraintId?: string;
  constraintType: ConstraintType;
  label: string;
  defaultValue: number;
  defaultExpression?: string;
  entityIds: string[];
  paramKey: 'distance' | 'radius' | 'angle';
}

interface SketchState {
  points: SketchPoint[];
  lines: SketchLine[];
  circles: SketchCircle[];
  arcs: SketchArc[];
  bsplines: SketchBspline[];
  constraints: SketchConstraint[];
  selection: SelectionItem[];
  statusMessage: string;
  pendingDimensionInput: DimensionInputRequest | null;
  pendingConstraintType: ConstraintType | null;

  addPoint: (x: number, y: number) => string;
  addLine: (p1Id: string, p2Id: string) => string;
  addCircle: (centerId: string, radius: number) => string;
  setCircleRadius: (circleId: string, radius: number) => void;
  addArc: (centerId: string, startId: string, endId: string, complementaryArc?: boolean) => string;
  addBspline: (controlPointIds: string[], degree?: number) => string;

  applyConstraint: (
    type: ConstraintType,
    options?: { skipHistory?: boolean }
  ) => { success: boolean; message: string };
  /** Point–point coincident (e.g. sketch tools snapping to existing geometry). Shows ◉ like manual coincident. */
  addCoincidentBetweenPoints: (
    pointIdA: string,
    pointIdB: string,
    options?: { skipHistory?: boolean }
  ) => { success: boolean; message: string };
  beginConstraintSelection: (type: ConstraintType) => void;
  clearPendingConstraintSelection: () => void;
  submitDimensionInput: (rawValue: string, sourceExpression?: string) => { success: boolean; message: string };
  cancelDimensionInput: () => void;
  requestEditDimension: (constraintId: string) => { success: boolean; message: string };
  updateConstraintParams: (constraintId: string, patch: Record<string, number>) => void;
  removeConstraint: (id: string) => void;
  solveConstraints: () => void;
  dragPoint: (pointId: string, x: number, y: number) => void;
  /** Project points onto the constraint manifold after a drag session ends. */
  finalizeDrag: () => void;
  /** Rigid translation of sketch points by (dx, dy), respecting fix constraints and re-solving. */
  translateSketchPoints: (pointIds: string[], dx: number, dy: number) => void;

  toggleSelect: (item: SelectionItem, multi: boolean) => void;
  clearSelection: () => void;

  deleteSelected: () => void;
  /** Flip auxiliary flag on selected lines, circles, and arcs (points/constraints ignored). */
  toggleAuxiliarySelected: () => void;
  clearSketch: () => void;
  setStatusMessage: (msg: string) => void;

  loadSketchData: (data: SketchDataSnapshot) => void;
  getSketchData: () => SketchDataSnapshot;

  sketchUndoPast: SketchHistorySnapshot[];
  sketchUndoFuture: SketchHistorySnapshot[];
  pushSketchHistory: () => void;
  undoSketch: () => void;
  redoSketch: () => void;

  findNearestPoint: (x: number, y: number, threshold: number) => string | null;
  findNearestEntity: (
    x: number,
    y: number,
    threshold: number
  ) => SelectionItem | null;
}

function uid(): string {
  return 'sk_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function ensureFixedOriginSeed(
  points: SketchPoint[],
  constraints: SketchConstraint[]
): { points: SketchPoint[]; constraints: SketchConstraint[] } {
  const ORIGIN_EPS = 1e-9;
  let origin = points.find((p) => Math.abs(p.x) < ORIGIN_EPS && Math.abs(p.y) < ORIGIN_EPS) || null;
  const nextPoints = [...points];
  if (!origin) {
    origin = { id: uid(), x: 0, y: 0 };
    nextPoints.push(origin);
  }
  const hasFix = constraints.some(
    (c) => c.type === 'fix' && c.entityIds.length === 1 && c.entityIds[0] === origin.id
  );
  if (hasFix) return { points: nextPoints, constraints };
  return {
    points: nextPoints,
    constraints: [...constraints, { id: uid(), type: 'fix', entityIds: [origin.id], params: { x: 0, y: 0 } }],
  };
}
const INITIAL_SKETCH_SEED = ensureFixedOriginSeed([], []);

function getProtectedOriginPointId(state: { points: SketchPoint[]; constraints: SketchConstraint[] }): string | null {
  const byFix = state.constraints.find(
    (c) =>
      c.type === 'fix' &&
      c.entityIds.length === 1 &&
      Number(c.params?.x) === 0 &&
      Number(c.params?.y) === 0 &&
      state.points.some((p) => p.id === c.entityIds[0])
  );
  if (byFix) return byFix.entityIds[0];
  const ORIGIN_EPS = 1e-9;
  const origin = state.points.find((p) => Math.abs(p.x) < ORIGIN_EPS && Math.abs(p.y) < ORIGIN_EPS);
  return origin?.id ?? null;
}

function getProtectedOriginFixConstraintId(state: { points: SketchPoint[]; constraints: SketchConstraint[] }): string | null {
  const pid = getProtectedOriginPointId(state);
  if (!pid) return null;
  const fix = state.constraints.find(
    (c) =>
      c.type === 'fix' &&
      c.entityIds.length === 1 &&
      c.entityIds[0] === pid &&
      Number(c.params?.x) === 0 &&
      Number(c.params?.y) === 0
  );
  return fix?.id ?? null;
}

function distToSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

function distToCircle(
  px: number, py: number,
  cx: number, cy: number,
  r: number
): number {
  const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
  return Math.abs(d - r);
}

/** Symmetry lists circle A then B; centers are solved as points — radii must stay matched (B ← A). */
function equalizeSymmetryCircleRadii(
  circles: SketchCircle[],
  constraints: SketchConstraint[]
): SketchCircle[] {
  let out = circles;
  for (const cn of constraints) {
    if (cn.type !== 'symmetry' || cn.entityIds.length !== 3) continue;
    const idA = cn.entityIds[1];
    const idB = cn.entityIds[2];
    const ca = out.find((c) => c.id === idA);
    const cb = out.find((c) => c.id === idB);
    if (!ca || !cb) continue;
    if (Math.abs(cb.radius - ca.radius) < 1e-12) continue;
    out = out.map((c) => (c.id === idB ? { ...c, radius: ca.radius } : c));
  }
  return out;
}

/**
 * Radius dimensions store the value on the constraint; circle radius is edited by dragging the
 * rim (`setCircleRadius`). When a dimension exists, that stored radius must win over the drag.
 * Also checks symmetry partners: a dimension on one circle locks the paired circle's radius too.
 */
function lockedRadiusForCircle(
  constraints: SketchConstraint[],
  circleId: string
): number | undefined {
  const pr = constraints.find(
    (c) =>
      c.type === 'radius' &&
      c.entityIds[0] === circleId &&
      c.params?.radius != null &&
      Number.isFinite(c.params.radius)
  )?.params?.radius;
  if (pr != null) return Math.max(1e-4, pr);

  for (const cn of constraints) {
    if (cn.type !== 'symmetry' || cn.entityIds.length !== 3) continue;
    const idA = cn.entityIds[1];
    const idB = cn.entityIds[2];
    if (idA !== circleId && idB !== circleId) continue;
    const partner = circleId === idA ? idB : idA;
    const partnerR = constraints.find(
      (c) =>
        c.type === 'radius' &&
        c.entityIds[0] === partner &&
        c.params?.radius != null &&
        Number.isFinite(c.params.radius)
    )?.params?.radius;
    if (partnerR != null) return Math.max(1e-4, partnerR);
  }
  return undefined;
}

/**
 * Applies a radius dimension value to sketch geometry. Circle radius is stored on the circle
 * entity (the constraint solver only drives arc start–center distance). Arc endpoints are
 * scaled radially from the center so the sweep is preserved.
 */
export function applyRadiusValueToSketchGeometry(
  points: SketchPoint[],
  circles: SketchCircle[],
  arcs: SketchArc[],
  constraints: SketchConstraint[],
  entityId: string,
  radius: number
): { points: SketchPoint[]; circles: SketchCircle[] } {
  const r = Math.max(1e-4, radius);
  const circ = circles.find((c) => c.id === entityId);
  if (circ) {
    let nextCircles = circles.map((c) => (c.id === entityId ? { ...c, radius: r } : c));
    for (const cn of constraints) {
      if (cn.type !== 'symmetry' || cn.entityIds.length !== 3) continue;
      const idA = cn.entityIds[1];
      const idB = cn.entityIds[2];
      if (idA !== entityId && idB !== entityId) continue;
      const partnerId = entityId === idA ? idB : idA;
      if (!nextCircles.some((c) => c.id === partnerId)) continue;
      nextCircles = nextCircles.map((c) => (c.id === partnerId ? { ...c, radius: r } : c));
    }
    return { points, circles: nextCircles };
  }
  const arc = arcs.find((a) => a.id === entityId);
  if (arc) {
    const center = points.find((p) => p.id === arc.centerId);
    if (!center) return { points, circles };
    const scalePoint = (pid: string): SketchPoint | undefined => {
      const p = points.find((pt) => pt.id === pid);
      if (!p) return undefined;
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) return { ...p, x: center.x + r, y: center.y };
      const s = r / len;
      return { ...p, x: center.x + dx * s, y: center.y + dy * s };
    };
    const ns = scalePoint(arc.startId);
    const ne = scalePoint(arc.endId);
    const nextPoints = points.map((p) => {
      if (p.id === arc.startId && ns) return ns;
      if (p.id === arc.endId && ne) return ne;
      return p;
    });
    return { points: nextPoints, circles };
  }
  return { points, circles };
}

/**
 * Re-solves sketch constraints after a driven dimension value changes outside the sketcher
 * (e.g. Parameters dialog). Updating `params` alone does not move points; the solver must run.
 */
export function resolveSketchDataAfterDimensionValueChange(sketchData: SketchDataSnapshot): SketchDataSnapshot {
  const { points, lines, circles, arcs, constraints } = sketchData;
  if (constraints.length === 0 || points.length === 0) return sketchData;

  const result = solveConstraints(
    points as SolverPoint[],
    lines as SolverLine[],
    circles as SolverCircle[],
    arcs as SolverArc[],
    constraints as SolverConstraint[]
  );

  if (result.points.length === 0) return sketchData;

  const nextCircles = equalizeSymmetryCircleRadii(circles, constraints);
  return {
    ...sketchData,
    points: result.points as SketchPoint[],
    circles: nextCircles,
  };
}

export const useSketchStore = create<SketchState>((set, get) => ({
  points: INITIAL_SKETCH_SEED.points,
  lines: [],
  circles: [],
  arcs: [],
  bsplines: [],
  constraints: INITIAL_SKETCH_SEED.constraints,
  selection: [],
  statusMessage: '',
  pendingDimensionInput: null,
  pendingConstraintType: null,
  sketchUndoPast: [],
  sketchUndoFuture: [],

  pushSketchHistory: () => {
    if (applyingSketchHistory) return;
    const s = get();
    const snap = cloneSketchHistorySnapshot(s);
    set((state) => ({
      sketchUndoPast: [...state.sketchUndoPast, snap].slice(-SKETCH_HISTORY_MAX),
      sketchUndoFuture: [],
    }));
  },

  undoSketch: () => {
    const s = get();
    if (s.sketchUndoPast.length === 0) return;
    applyingSketchHistory = true;
    try {
      const prev = s.sketchUndoPast[s.sketchUndoPast.length - 1];
      const current = cloneSketchHistorySnapshot(s);
      const newPast = s.sketchUndoPast.slice(0, -1);
      set({
        ...prev,
        bsplines: prev.bsplines ?? [],
        sketchUndoPast: newPast,
        sketchUndoFuture: [...s.sketchUndoFuture, current],
      });
      get().solveConstraints();
    } finally {
      applyingSketchHistory = false;
    }
  },

  redoSketch: () => {
    const s = get();
    if (s.sketchUndoFuture.length === 0) return;
    applyingSketchHistory = true;
    try {
      const next = s.sketchUndoFuture[s.sketchUndoFuture.length - 1];
      const current = cloneSketchHistorySnapshot(s);
      const newFuture = s.sketchUndoFuture.slice(0, -1);
      set({
        ...next,
        bsplines: next.bsplines ?? [],
        sketchUndoPast: [...s.sketchUndoPast, current].slice(-SKETCH_HISTORY_MAX),
        sketchUndoFuture: newFuture,
      });
      get().solveConstraints();
    } finally {
      applyingSketchHistory = false;
    }
  },

  addPoint: (x: number, y: number) => {
    const id = uid();
    set((s) => ({ points: [...s.points, { id, x, y }] }));
    return id;
  },

  addLine: (p1Id: string, p2Id: string) => {
    const id = uid();
    set((s) => ({ lines: [...s.lines, { id, p1Id, p2Id }] }));
    return id;
  },

  addCircle: (centerId: string, radius: number) => {
    const id = uid();
    set((s) => ({ circles: [...s.circles, { id, centerId, radius }] }));
    return id;
  },

  setCircleRadius: (circleId: string, radius: number) => {
    set((s) => {
      const locked = lockedRadiusForCircle(s.constraints, circleId);
      const r = Math.max(1e-4, locked ?? radius);
      let circles = s.circles.map((c) => (c.id === circleId ? { ...c, radius: r } : c));
      for (const cn of s.constraints) {
        if (cn.type !== 'symmetry' || cn.entityIds.length !== 3) continue;
        const idA = cn.entityIds[1];
        const idB = cn.entityIds[2];
        if (idA !== circleId && idB !== circleId) continue;
        const partnerId = circleId === idA ? idB : idA;
        if (!circles.some((c) => c.id === partnerId)) continue;
        circles = circles.map((c) => (c.id === partnerId ? { ...c, radius: r } : c));
      }
      return { circles };
    });
    get().solveConstraints();
  },

  addArc: (centerId: string, startId: string, endId: string, complementaryArc?: boolean) => {
    const id = uid();
    const state = get();
    const center = state.points.find((p) => p.id === centerId);
    const start = state.points.find((p) => p.id === startId);
    if (!center || !start) return id;

    const arcConstraintId = uid();
    set((s) => ({
      arcs: [
        ...s.arcs,
        {
          id,
          centerId,
          startId,
          endId,
          ...(complementaryArc ? { complementaryArc: true } : {}),
        },
      ],
      constraints: [
        ...s.constraints,
        { id: arcConstraintId, type: 'arcRadius' as ConstraintType, entityIds: [id] },
      ],
    }));
    return id;
  },

  addBspline: (controlPointIds: string[], degree = BSPLINE_DEFAULT_DEGREE) => {
    const id = uid();
    const p = Math.max(1, Math.min(degree, 8));
    if (controlPointIds.length < p + 1) return id;
    set((s) => ({
      bsplines: [
        ...s.bsplines,
        {
          id,
          controlPointIds: [...controlPointIds],
          degree: p,
        },
      ],
    }));
    return id;
  },

  applyConstraint: (type: ConstraintType, options?: { skipHistory?: boolean }) => {
    const state = get();
    const sel = state.selection;

    const selPoints = sel.filter((s) => s.type === 'point');
    const selLines = sel.filter((s) => s.type === 'line');
    const selCircles = sel.filter((s) => s.type === 'circle');
    const selArcs = sel.filter((s) => s.type === 'arc');
    const selCurves = [...selCircles, ...selArcs];

    let entityIds: string[] = [];
    let params: Record<string, number> | undefined;
    let valid = false;
    let pendingInput: DimensionInputRequest | null = null;
    /** When the chosen tool maps to another constraint kind (e.g. Coincident + line/point → pointOnLine). */
    let resolvedType: ConstraintType = type;

    switch (type) {
      case 'fix':
        if (selPoints.length === 1) {
          if (selPoints[0].id === SKETCH_REF_ORIGIN_ID) break;
          const p = state.points.find((pt) => pt.id === selPoints[0].id);
          if (p) {
            entityIds = [p.id];
            params = { x: p.x, y: p.y };
            valid = true;
          }
        }
        break;

      case 'coincident':
        if (selPoints.length === 2) {
          entityIds = [selPoints[0].id, selPoints[1].id];
          valid = true;
        } else if (selLines.length === 1 && selPoints.length === 1) {
          entityIds = [selLines[0].id, selPoints[0].id];
          valid = true;
          resolvedType = 'pointOnLine';
        }
        break;

      case 'horizontal':
        if (selLines.length === 1) {
          entityIds = [selLines[0].id];
          valid = true;
        }
        break;

      case 'vertical':
        if (selLines.length === 1) {
          entityIds = [selLines[0].id];
          valid = true;
        }
        break;

      case 'equal':
        if (selLines.length === 2) {
          entityIds = [selLines[0].id, selLines[1].id];
          valid = true;
        }
        break;

      case 'parallel':
        if (selLines.length === 2) {
          entityIds = [selLines[0].id, selLines[1].id];
          valid = true;
        }
        break;

      case 'perpendicular':
        if (selLines.length === 2) {
          entityIds = [selLines[0].id, selLines[1].id];
          valid = true;
        }
        break;

      case 'tangent':
        if (selLines.length === 1 && selCurves.length === 1) {
          entityIds = [selLines[0].id, selCurves[0].id];
          valid = true;
        }
        break;

      case 'concentric':
        if (selCurves.length === 2) {
          entityIds = [selCurves[0].id, selCurves[1].id];
          valid = true;
        }
        break;

      case 'midpoint':
        if (selLines.length === 1 && selPoints.length === 1) {
          entityIds = [selLines[0].id, selPoints[0].id];
          valid = true;
        }
        break;

      case 'pointOnLine':
        if (selLines.length === 1 && selPoints.length === 1) {
          entityIds = [selLines[0].id, selPoints[0].id];
          valid = true;
        }
        break;

      case 'distance':
        if (selLines.length === 1) {
          const line = state.lines.find((l) => l.id === selLines[0].id);
          if (line) {
            const p1 = state.points.find((p) => p.id === line.p1Id);
            const p2 = state.points.find((p) => p.id === line.p2Id);
            if (p1 && p2) {
              const d = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
              pendingInput = {
                mode: 'create',
                constraintType: 'distance',
                label: 'Enter distance',
                defaultValue: d,
                entityIds: [selLines[0].id],
                paramKey: 'distance',
              };
              valid = true;
            }
          }
        } else if (selPoints.length === 2) {
          const p1 = state.points.find((p) => p.id === selPoints[0].id);
          const p2 = state.points.find((p) => p.id === selPoints[1].id);
          if (p1 && p2) {
            const d = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
            pendingInput = {
              mode: 'create',
              constraintType: 'distance',
              label: 'Enter distance',
              defaultValue: d,
              entityIds: [selPoints[0].id, selPoints[1].id],
              paramKey: 'distance',
            };
            valid = true;
          }
        }
        break;

      case 'length':
        if (selLines.length === 1) {
          const line = state.lines.find((l) => l.id === selLines[0].id);
          if (line) {
            const p1 = state.points.find((p) => p.id === line.p1Id);
            const p2 = state.points.find((p) => p.id === line.p2Id);
            if (p1 && p2) {
              const d = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
              pendingInput = {
                mode: 'create',
                constraintType: 'length',
                label: 'Enter length',
                defaultValue: d,
                entityIds: [selLines[0].id],
                paramKey: 'distance',
              };
              valid = true;
            }
          }
        }
        break;

      case 'horizontalDistance':
        if (selPoints.length === 2) {
          const p1 = state.points.find((p) => p.id === selPoints[0].id);
          const p2 = state.points.find((p) => p.id === selPoints[1].id);
          if (p1 && p2) {
            const d = Math.abs(p2.x - p1.x);
            pendingInput = {
              mode: 'create',
              constraintType: 'horizontalDistance',
              label: 'Enter horizontal distance',
              defaultValue: d,
              entityIds: [selPoints[0].id, selPoints[1].id],
              paramKey: 'distance',
            };
            valid = true;
          }
        }
        break;

      case 'verticalDistance':
        if (selPoints.length === 2) {
          const p1 = state.points.find((p) => p.id === selPoints[0].id);
          const p2 = state.points.find((p) => p.id === selPoints[1].id);
          if (p1 && p2) {
            const d = Math.abs(p2.y - p1.y);
            pendingInput = {
              mode: 'create',
              constraintType: 'verticalDistance',
              label: 'Enter vertical distance',
              defaultValue: d,
              entityIds: [selPoints[0].id, selPoints[1].id],
              paramKey: 'distance',
            };
            valid = true;
          }
        }
        break;

      case 'radius':
        if (selCircles.length === 1) {
          const circ = state.circles.find((c) => c.id === selCircles[0].id);
          if (circ) {
            pendingInput = {
              mode: 'create',
              constraintType: 'radius',
              label: 'Enter radius',
              defaultValue: circ.radius,
              entityIds: [selCircles[0].id],
              paramKey: 'radius',
            };
            valid = true;
          }
        } else if (selArcs.length === 1) {
          const arc = state.arcs.find((a) => a.id === selArcs[0].id);
          if (arc) {
            const c = state.points.find((p) => p.id === arc.centerId);
            const s = state.points.find((p) => p.id === arc.startId);
            if (c && s) {
              const curR = Math.sqrt((s.x - c.x) ** 2 + (s.y - c.y) ** 2);
              pendingInput = {
                mode: 'create',
                constraintType: 'radius',
                label: 'Enter radius',
                defaultValue: curR,
                entityIds: [selArcs[0].id],
                paramKey: 'radius',
              };
              valid = true;
            }
          }
        }
        break;

      case 'symmetry': {
        if (sel.length !== 3) break;
        if (sel[0].type !== 'line') break;
        if (sel[1].type !== sel[2].type) break;
        if (sel[1].id === sel[2].id) break;
        entityIds = [sel[0].id, sel[1].id, sel[2].id];
        // Line–line: pair endpoints so each A endpoint matches the nearer B endpoint (true
        // corner partners). Opposite p1/p2 winding on one edge otherwise pairs diagonals and
        // drives width → 0. Do not use the axis line from state — ref x/y axes are not in
        // state.lines, so axis-based residual pairing was skipped and swap never applied.
        if (sel[1].type === 'line' && sel[2].type === 'line') {
          const lineA = state.lines.find((l) => l.id === sel[1].id);
          const lineB = state.lines.find((l) => l.id === sel[2].id);
          if (lineA && lineB) {
            const pt = (id: string) => state.points.find((p) => p.id === id);
            const a1 = pt(lineA.p1Id),
              a2 = pt(lineA.p2Id);
            const b1 = pt(lineB.p1Id),
              b2 = pt(lineB.p2Id);
            if (a1 && a2 && b1 && b2) {
              const dx1 = a1.x - b1.x,
                dy1 = a1.y - b1.y;
              const dx2 = a1.x - b2.x,
                dy2 = a1.y - b2.y;
              const d1 = dx1 * dx1 + dy1 * dy1;
              const d2 = dx2 * dx2 + dy2 * dy2;
              if (d2 < d1 - 1e-12) {
                params = { swapLineBEndpoints: 1 };
              }
            }
          }
        }
        valid = true;
        break;
      }

      case 'angle':
        if (selLines.length === 2) {
          const l1 = state.lines.find((l) => l.id === selLines[0].id);
          const l2 = state.lines.find((l) => l.id === selLines[1].id);
          if (l1 && l2) {
            const p1a = state.points.find((p) => p.id === l1.p1Id);
            const p1b = state.points.find((p) => p.id === l1.p2Id);
            const p2a = state.points.find((p) => p.id === l2.p1Id);
            const p2b = state.points.find((p) => p.id === l2.p2Id);
            if (p1a && p1b && p2a && p2b) {
              const dx1 = p1b.x - p1a.x, dy1 = p1b.y - p1a.y;
              const dx2 = p2b.x - p2a.x, dy2 = p2b.y - p2a.y;
              const dot = dx1 * dx2 + dy1 * dy2;
              const cross = dx1 * dy2 - dy1 * dx2;
              const angleDeg = Math.abs(Math.atan2(cross, dot)) * 180 / Math.PI;
              pendingInput = {
                mode: 'create',
                constraintType: 'angle',
                label: 'Enter angle (degrees)',
                defaultValue: angleDeg,
                entityIds: [selLines[0].id, selLines[1].id],
                paramKey: 'angle',
              };
              valid = true;
            }
          }
        }
        break;
    }

    if (pendingInput) {
      set({
        pendingDimensionInput: pendingInput,
        statusMessage: `${pendingInput.label}:`,
      });
      return { success: true, message: 'Awaiting dimension input' };
    }

    if (!valid) {
      const messages: Record<string, string> = {
        fix: 'Select 1 point',
        coincident: 'Select 2 points, or 1 line and 1 point',
        horizontal: 'Select 1 line',
        vertical: 'Select 1 line',
        equal: 'Select 2 lines',
        parallel: 'Select 2 lines',
        perpendicular: 'Select 2 lines',
        tangent: 'Select 1 line and 1 circle/arc',
        concentric: 'Select 2 circles/arcs',
        midpoint: 'Select 1 line and 1 point',
        pointOnLine: 'Select 1 line and 1 point',
        distance: 'Select 1 line or 2 points',
        length: 'Select 1 line',
        horizontalDistance: 'Select 2 points',
        verticalDistance: 'Select 2 points',
        radius: 'Select 1 circle or 1 arc',
        angle: 'Select 2 lines',
        symmetry: 'Select axis line, then entity A, then entity B (order matters)',
      };
      const msg = messages[type] || 'Invalid selection';
      set({ statusMessage: msg });
      return { success: false, message: msg };
    }

    if (!options?.skipHistory) {
      get().pushSketchHistory();
    }

    const constraintId = uid();
    const newConstraint: SketchConstraint = {
      id: constraintId,
      type: resolvedType,
      entityIds,
      ...(params && { params }),
    };

    set((s) => {
      const nextConstraints = [...s.constraints, newConstraint];
      const circles = equalizeSymmetryCircleRadii(s.circles, nextConstraints);
      return { constraints: nextConstraints, circles };
    });

    get().solveConstraints();

    const appliedLabel = type === 'coincident' ? 'Coincident' : resolvedType;
    set({ statusMessage: `${appliedLabel} constraint applied` });
    return { success: true, message: `${appliedLabel} constraint applied` };
  },

  addCoincidentBetweenPoints: (pointIdA, pointIdB, options) => {
    if (pointIdA === pointIdB) {
      return { success: false, message: 'Same point' };
    }
    const state = get();
    const pa = state.points.some((p) => p.id === pointIdA);
    const pb = state.points.some((p) => p.id === pointIdB);
    if (!pa || !pb) {
      return { success: false, message: 'Point not found' };
    }
    const dup = state.constraints.some(
      (c) =>
        c.type === 'coincident' &&
        c.entityIds.length === 2 &&
        ((c.entityIds[0] === pointIdA && c.entityIds[1] === pointIdB) ||
          (c.entityIds[0] === pointIdB && c.entityIds[1] === pointIdA))
    );
    if (dup) {
      return { success: true, message: 'Already coincident' };
    }

    if (!options?.skipHistory) {
      get().pushSketchHistory();
    }

    const constraintId = uid();
    const newConstraint: SketchConstraint = {
      id: constraintId,
      type: 'coincident',
      entityIds: [pointIdA, pointIdB],
    };

    set((s) => {
      const nextConstraints = [...s.constraints, newConstraint];
      const circles = equalizeSymmetryCircleRadii(s.circles, nextConstraints);
      return { constraints: nextConstraints, circles };
    });

    get().solveConstraints();

    if (!options?.skipHistory) {
      set({ statusMessage: 'Coincident constraint applied' });
    }
    return { success: true, message: 'Coincident constraint applied' };
  },

  beginConstraintSelection: (type: ConstraintType) => {
    const hints: Record<string, string> = {
      fix: 'Select 1 point',
      coincident: 'Select 2 points, or 1 line and 1 point',
      horizontal: 'Select 1 line',
      vertical: 'Select 1 line',
      equal: 'Select 2 lines',
      parallel: 'Select 2 lines',
      perpendicular: 'Select 2 lines',
      tangent: 'Select 1 line and 1 circle/arc',
      concentric: 'Select 2 circles/arcs',
      midpoint: 'Select 1 line and 1 point',
      pointOnLine: 'Select 1 line and 1 point',
      distance: 'Select 1 line or 2 points',
      length: 'Select 1 line',
      horizontalDistance: 'Select 2 points',
      verticalDistance: 'Select 2 points',
      radius: 'Select 1 circle or 1 arc',
      angle: 'Select 2 lines',
      symmetry: '1) Symmetry axis (line)  2) Entity A  3) Entity B',
    };
    set({
      pendingConstraintType: type,
      statusMessage: `${hints[type] ?? 'Select required entities'} — ${type}`,
    });
  },

  clearPendingConstraintSelection: () => set({ pendingConstraintType: null }),

  submitDimensionInput: (rawValue: string, sourceExpression?: string) => {
    const req = get().pendingDimensionInput;
    if (!req) return { success: false, message: 'No pending dimension input' };

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const msg = 'Enter a positive number';
      set({ statusMessage: msg });
      return { success: false, message: msg };
    }

    get().pushSketchHistory();

    const params: Record<string, number> = { [req.paramKey]: parsed };
    set((s) => {
      let circles = s.circles;
      let points = s.points;
      if (req.paramKey === 'radius' && req.entityIds[0]) {
        const g = applyRadiusValueToSketchGeometry(
          s.points,
          s.circles,
          s.arcs,
          s.constraints,
          req.entityIds[0],
          parsed
        );
        points = g.points;
        circles = g.circles;
      }

      if (req.mode === 'edit' && req.constraintId) {
        return {
          points,
          circles,
          constraints: s.constraints.map((c) => {
            if (c.id !== req.constraintId) return c;
            const nextParams = { ...(c.params ?? {}), ...params };
            return {
              ...c,
              params: nextParams,
              ...(sourceExpression?.trim().startsWith('=') ? { expression: sourceExpression.trim() } : {}),
            };
          }),
          pendingDimensionInput: null,
          statusMessage: `${req.constraintType} constraint updated`,
        };
      }

      const newConstraint: SketchConstraint = {
        id: uid(),
        type: req.constraintType,
        entityIds: req.entityIds,
        params,
        ...(sourceExpression?.trim().startsWith('=') ? { expression: sourceExpression.trim() } : {}),
      };
      return {
        points,
        circles,
        constraints: [...s.constraints, newConstraint],
        pendingDimensionInput: null,
        statusMessage: `${req.constraintType} constraint applied`,
      };
    });

    get().solveConstraints();
    return { success: true, message: req.mode === 'edit' ? `${req.constraintType} constraint updated` : `${req.constraintType} constraint applied` };
  },

  cancelDimensionInput: () => set({ pendingDimensionInput: null, statusMessage: '' }),

  requestEditDimension: (constraintId: string) => {
    const state = get();
    const c = state.constraints.find((cc) => cc.id === constraintId);
    if (!c) return { success: false, message: 'Constraint not found' };
    if (!['distance', 'length', 'horizontalDistance', 'verticalDistance', 'radius', 'angle'].includes(c.type)) {
      return { success: false, message: 'Not a dimension constraint' };
    }

    const paramKey: 'distance' | 'radius' | 'angle' =
      c.type === 'radius' ? 'radius' : c.type === 'angle' ? 'angle' : 'distance';
    const current = Number(c.params?.[paramKey]);
    if (!Number.isFinite(current)) return { success: false, message: 'Dimension value unavailable' };

    const labelByType: Record<string, string> = {
      distance: 'Edit distance',
      length: 'Edit length',
      horizontalDistance: 'Edit horizontal distance',
      verticalDistance: 'Edit vertical distance',
      radius: 'Edit radius',
      angle: 'Edit angle (degrees)',
    };

    set({
      pendingDimensionInput: {
        mode: 'edit',
        constraintId: c.id,
        constraintType: c.type,
        label: labelByType[c.type] ?? 'Edit dimension',
        defaultValue: current,
        defaultExpression: c.expression,
        entityIds: c.entityIds,
        paramKey,
      },
      statusMessage: 'Edit dimension value',
    });
    return { success: true, message: 'Editing dimension' };
  },

  updateConstraintParams: (constraintId: string, patch: Record<string, number>) => {
    set((s) => ({
      constraints: s.constraints.map((c) => {
        if (c.id !== constraintId) return c;
        return { ...c, params: { ...(c.params ?? {}), ...patch } };
      }),
    }));
  },

  removeConstraint: (id: string) => {
    get().pushSketchHistory();
    set((s) => ({ constraints: s.constraints.filter((c) => c.id !== id) }));
  },

  solveConstraints: () => {
    const state = get();
    if (state.constraints.length === 0) return;

    const result = solveConstraints(
      state.points as SolverPoint[],
      state.lines as SolverLine[],
      state.circles as SolverCircle[],
      state.arcs as SolverArc[],
      state.constraints as SolverConstraint[]
    );

    if (result.points.length > 0) {
      const circles = equalizeSymmetryCircleRadii(state.circles, state.constraints);
      set({ points: result.points, circles });
    }
  },

  dragPoint: (pointId: string, x: number, y: number) => {
    const state = get();
    const point = state.points.find((p) => p.id === pointId);
    if (!point) return;

    if (state.constraints.length === 0) {
      set({
        points: state.points.map((p) => (p.id === pointId ? { ...p, x, y } : p)),
      });
      return;
    }

    if (state.constraints.some((c) => c.type === 'fix' && c.entityIds[0] === pointId)) return;

    // Single solver call per frame. DRAG_CONSTRAINT_SCALE (1e4) inside
    // solveConstraints keeps constraints tight, so sub-stepping is unnecessary.
    // Projection is deferred to finalizeDrag (called on pointer-up).
    const result = solveConstraints(
      state.points as SolverPoint[],
      state.lines as SolverLine[],
      state.circles as SolverCircle[],
      state.arcs as SolverArc[],
      state.constraints as SolverConstraint[],
      { pointId, x, y, strength: 10 },
      50
    );

    if (result.points.length > 0 && result.constraintEnergy < 1e-2) {
      set({ points: result.points as SketchPoint[] });
    }
  },

  finalizeDrag: () => {
    const state = get();
    if (state.constraints.length === 0) return;
    const result = solveConstraints(
      state.points as SolverPoint[],
      state.lines as SolverLine[],
      state.circles as SolverCircle[],
      state.arcs as SolverArc[],
      state.constraints as SolverConstraint[],
      undefined,
      100
    );
    if (result.constraintEnergy < 1e-6) {
      set({ points: result.points as SketchPoint[] });
    }
  },

  translateSketchPoints: (pointIds: string[], dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    const state = get();
    const fixedIds = new Set<string>();
    for (const c of state.constraints) {
      if (c.type === 'fix' && c.entityIds.length === 1) {
        fixedIds.add(c.entityIds[0]);
      }
    }
    const ids = [...new Set(pointIds)].filter((id) => !fixedIds.has(id));
    if (ids.length === 0) return;

    const nextPoints = state.points.map((p) =>
      ids.includes(p.id) ? { ...p, x: p.x + dx, y: p.y + dy } : p
    );

    if (state.constraints.length === 0) {
      set({ points: nextPoints });
      return;
    }

    const result = solveConstraints(
      nextPoints as SolverPoint[],
      state.lines as SolverLine[],
      state.circles as SolverCircle[],
      state.arcs as SolverArc[],
      state.constraints as SolverConstraint[]
    );
    if (result.points.length > 0) {
      set({ points: result.points as SketchPoint[] });
    }
  },

  toggleSelect: (item: SelectionItem, multi: boolean) => {
    set((s) => {
      const exists = s.selection.find(
        (sel) => sel.type === item.type && sel.id === item.id
      );
      if (exists) {
        return { selection: s.selection.filter((sel) => sel !== exists) };
      }
      if (multi) {
        return { selection: [...s.selection, item] };
      }
      return { selection: [item] };
    });
  },

  clearSelection: () => set({ selection: [] }),

  deleteSelected: () => {
    const state = get();
    if (state.selection.length === 0) return;
    get().pushSketchHistory();
    const protectedOriginPointId = getProtectedOriginPointId(state);
    const protectedOriginFixConstraintId = getProtectedOriginFixConstraintId(state);
    const selectedPointIds = new Set(
      state.selection.filter((s) => s.type === 'point').map((s) => s.id)
    );
    const selectedLineIds = new Set(
      state.selection.filter((s) => s.type === 'line').map((s) => s.id)
    );
    const selectedCircleIds = new Set(
      state.selection.filter((s) => s.type === 'circle').map((s) => s.id)
    );
    const selectedArcIds = new Set(
      state.selection.filter((s) => s.type === 'arc').map((s) => s.id)
    );
    const selectedBsplineIds = new Set(
      state.selection.filter((s) => s.type === 'bspline').map((s) => s.id)
    );
    const selectedConstraintIds = new Set(
      state.selection.filter((s) => s.type === 'constraint').map((s) => s.id)
    );
    if (protectedOriginPointId) selectedPointIds.delete(protectedOriginPointId);
    if (protectedOriginFixConstraintId) selectedConstraintIds.delete(protectedOriginFixConstraintId);

    const linesToDelete = state.lines.filter(
      (l) =>
        selectedLineIds.has(l.id) ||
        selectedPointIds.has(l.p1Id) ||
        selectedPointIds.has(l.p2Id)
    );
    const circlesToDelete = state.circles.filter(
      (c) => selectedCircleIds.has(c.id) || selectedPointIds.has(c.centerId)
    );
    const arcsToDelete = state.arcs.filter(
      (a) =>
        selectedArcIds.has(a.id) ||
        selectedPointIds.has(a.centerId) ||
        selectedPointIds.has(a.startId) ||
        selectedPointIds.has(a.endId)
    );
    const bsplinesToDelete = state.bsplines.filter(
      (b) =>
        selectedBsplineIds.has(b.id) ||
        b.controlPointIds.some((pid) => selectedPointIds.has(pid))
    );

    const allDeletedLineIds = new Set(linesToDelete.map((l) => l.id));
    const allDeletedCircleIds = new Set(circlesToDelete.map((c) => c.id));
    const allDeletedArcIds = new Set(arcsToDelete.map((a) => a.id));
    const allDeletedBsplineIds = new Set(bsplinesToDelete.map((b) => b.id));
    const allDeletedEntityIds = new Set([
      ...selectedPointIds,
      ...allDeletedLineIds,
      ...allDeletedCircleIds,
      ...allDeletedArcIds,
      ...allDeletedBsplineIds,
    ]);

    const orphanPointIds = new Set<string>();
    for (const l of linesToDelete) {
      orphanPointIds.add(l.p1Id);
      orphanPointIds.add(l.p2Id);
    }
    for (const c of circlesToDelete) orphanPointIds.add(c.centerId);
    for (const a of arcsToDelete) {
      orphanPointIds.add(a.centerId);
      orphanPointIds.add(a.startId);
      orphanPointIds.add(a.endId);
    }
    for (const b of bsplinesToDelete) {
      for (const pid of b.controlPointIds) orphanPointIds.add(pid);
    }

    const remainingLines = state.lines.filter((l) => !allDeletedLineIds.has(l.id));
    const remainingCircles = state.circles.filter((c) => !allDeletedCircleIds.has(c.id));
    const remainingArcs = state.arcs.filter((a) => !allDeletedArcIds.has(a.id));
    const remainingBsplines = state.bsplines.filter((b) => !allDeletedBsplineIds.has(b.id));

    const usedPointIds = new Set<string>();
    for (const l of remainingLines) {
      usedPointIds.add(l.p1Id);
      usedPointIds.add(l.p2Id);
    }
    for (const c of remainingCircles) usedPointIds.add(c.centerId);
    for (const a of remainingArcs) {
      usedPointIds.add(a.centerId);
      usedPointIds.add(a.startId);
      usedPointIds.add(a.endId);
    }
    for (const b of remainingBsplines) {
      for (const pid of b.controlPointIds) usedPointIds.add(pid);
    }

    const pointsToRemove = new Set<string>(selectedPointIds);
    for (const pid of orphanPointIds) {
      if (!usedPointIds.has(pid)) pointsToRemove.add(pid);
    }
    if (protectedOriginPointId) pointsToRemove.delete(protectedOriginPointId);

    const newConstraints = state.constraints.filter(
      (c) =>
        !selectedConstraintIds.has(c.id) &&
        !c.entityIds.some((eid) => allDeletedEntityIds.has(eid) || pointsToRemove.has(eid))
    );

    set({
      points: state.points.filter((p) => !pointsToRemove.has(p.id)),
      lines: remainingLines,
      circles: remainingCircles,
      arcs: remainingArcs,
      bsplines: remainingBsplines,
      constraints: newConstraints,
      selection: [],
    });
  },

  toggleAuxiliarySelected: () => {
    const pre = get();
    const sel0 = pre.selection;
    const hasCurve =
      sel0.some((x) => x.type === 'line') ||
      sel0.some((x) => x.type === 'circle') ||
      sel0.some((x) => x.type === 'arc') ||
      sel0.some((x) => x.type === 'bspline');
    if (!hasCurve) return;
    get().pushSketchHistory();
    set((s) => {
      const sel = s.selection;
      const lineIds = new Set(sel.filter((x) => x.type === 'line').map((x) => x.id));
      const circleIds = new Set(sel.filter((x) => x.type === 'circle').map((x) => x.id));
      const arcIds = new Set(sel.filter((x) => x.type === 'arc').map((x) => x.id));
      const bsplineIds = new Set(sel.filter((x) => x.type === 'bspline').map((x) => x.id));
      if (lineIds.size === 0 && circleIds.size === 0 && arcIds.size === 0 && bsplineIds.size === 0) return s;
      return {
        lines: s.lines.map((l) =>
          lineIds.has(l.id) ? { ...l, auxiliary: !l.auxiliary } : l
        ),
        circles: s.circles.map((c) =>
          circleIds.has(c.id) ? { ...c, auxiliary: !c.auxiliary } : c
        ),
        arcs: s.arcs.map((a) =>
          arcIds.has(a.id) ? { ...a, auxiliary: !a.auxiliary } : a
        ),
        bsplines: s.bsplines.map((b) =>
          bsplineIds.has(b.id) ? { ...b, auxiliary: !b.auxiliary } : b
        ),
      };
    });
  },

  clearSketch: () =>
    set(() => {
      const seeded = ensureFixedOriginSeed([], []);
      return {
      points: seeded.points,
      lines: [],
      circles: [],
      arcs: [],
      bsplines: [],
      constraints: seeded.constraints,
      selection: [],
      statusMessage: '',
      pendingDimensionInput: null,
      pendingConstraintType: null,
      sketchUndoPast: [],
      sketchUndoFuture: [],
      };
    }),

  setStatusMessage: (msg: string) => set({ statusMessage: msg }),

  loadSketchData: (data: SketchDataSnapshot) => {
    const seeded = ensureFixedOriginSeed(
      data.points || [],
      (data.constraints || []) as SketchConstraint[]
    );
    set({
      points: seeded.points,
      lines: data.lines || [],
      circles: data.circles || [],
      arcs: data.arcs || [],
      bsplines: data.bsplines || [],
      constraints: seeded.constraints,
      selection: [],
      statusMessage: '',
      pendingDimensionInput: null,
      pendingConstraintType: null,
      sketchUndoPast: [],
      sketchUndoFuture: [],
    });
  },

  getSketchData: (): SketchDataSnapshot => {
    const s = get();
    return {
      points: s.points,
      lines: s.lines,
      circles: s.circles,
      arcs: s.arcs,
      bsplines: s.bsplines,
      constraints: s.constraints,
    };
  },

  findNearestPoint: (x: number, y: number, threshold: number) => {
    const state = get();
    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const p of state.points) {
      const d = Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2);
      if (d <= threshold && d < bestDist) {
        bestDist = d;
        bestId = p.id;
      }
    }
    return bestId;
  },

  findNearestEntity: (x: number, y: number, threshold: number) => {
    const state = get();
    let best: SelectionItem | null = null;
    let bestDist = threshold;

    for (const p of state.points) {
      const d = Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2);
      if (d < bestDist) {
        bestDist = d;
        best = { type: 'point', id: p.id };
      }
    }

    for (const l of state.lines) {
      const p1 = state.points.find((p) => p.id === l.p1Id);
      const p2 = state.points.find((p) => p.id === l.p2Id);
      if (!p1 || !p2) continue;
      const d = distToSegment(x, y, p1.x, p1.y, p2.x, p2.y);
      if (d < bestDist) {
        bestDist = d;
        best = { type: 'line', id: l.id };
      }
    }

    for (const c of state.circles) {
      const center = state.points.find((p) => p.id === c.centerId);
      if (!center) continue;
      const d = distToCircle(x, y, center.x, center.y, c.radius);
      if (d < bestDist) {
        bestDist = d;
        best = { type: 'circle', id: c.id };
      }
    }

    for (const a of state.arcs) {
      const center = state.points.find((p) => p.id === a.centerId);
      const start = state.points.find((p) => p.id === a.startId);
      const end = state.points.find((p) => p.id === a.endId);
      if (!center || !start || !end) continue;
      const samples = sampleArcPoints(
        { x: center.x, y: center.y },
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
        Math.PI / 20,
        { complementaryArc: !!a.complementaryArc }
      );
      let dArc = Infinity;
      for (let i = 0; i < samples.length - 1; i++) {
        const ds = distToSegment(
          x,
          y,
          samples[i].x,
          samples[i].y,
          samples[i + 1].x,
          samples[i + 1].y
        );
        if (ds < dArc) dArc = ds;
      }
      if (dArc < bestDist) {
        bestDist = dArc;
        best = { type: 'arc', id: a.id };
      }
    }

    for (const b of state.bsplines) {
      const deg = b.degree ?? BSPLINE_DEFAULT_DEGREE;
      const ctrl = b.controlPointIds
        .map((pid) => state.points.find((p) => p.id === pid))
        .filter((p): p is SketchPoint => !!p);
      if (ctrl.length !== b.controlPointIds.length || ctrl.length < deg + 1) continue;
      const samples = sampleOpenUniformBSpline(ctrl, deg, BSPLINE_HIT_SAMPLES_PER_SPAN);
      let dMin = Infinity;
      for (let i = 0; i < samples.length - 1; i++) {
        const ds = distToSegment(
          x,
          y,
          samples[i].x,
          samples[i].y,
          samples[i + 1].x,
          samples[i + 1].y
        );
        if (ds < dMin) dMin = ds;
      }
      if (dMin < bestDist) {
        bestDist = dMin;
        best = { type: 'bspline', id: b.id };
      }
    }

    // Built-in principal axes selectable for constraints.
    // Evaluate after model entities so they don't steal picks from user geometry.
    const dXAxis = Math.abs(y); // distance to y = 0
    if (dXAxis < bestDist) {
      bestDist = dXAxis;
      best = { type: 'line', id: SKETCH_REF_X_AXIS_ID };
    }

    const dYAxis = Math.abs(x); // distance to x = 0
    if (dYAxis < bestDist) {
      bestDist = dYAxis;
      best = { type: 'line', id: SKETCH_REF_Y_AXIS_ID };
    }

    return best;
  },
}));
