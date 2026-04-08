import { create } from 'zustand';
import {
  solveConstraints,
  type SolverPoint,
  type SolverLine,
  type SolverCircle,
  type SolverArc,
  type SolverConstraint,
} from '../lib/constraintSolver';

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
}

export interface SketchCircle {
  id: string;
  centerId: string;
  radius: number;
}

export interface SketchArc {
  id: string;
  centerId: string;
  startId: string;
  endId: string;
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
  | 'angle';

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  entityIds: string[];
  params?: Record<string, number>;
  expression?: string;
}

export interface SelectionItem {
  type: 'point' | 'line' | 'circle' | 'arc' | 'constraint';
  id: string;
}

export interface SketchDataSnapshot {
  points: SketchPoint[];
  lines: SketchLine[];
  circles: SketchCircle[];
  arcs: SketchArc[];
  constraints: SketchConstraint[];
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
  circleIdToUpdate?: string;
}

interface SketchState {
  points: SketchPoint[];
  lines: SketchLine[];
  circles: SketchCircle[];
  arcs: SketchArc[];
  constraints: SketchConstraint[];
  selection: SelectionItem[];
  statusMessage: string;
  pendingDimensionInput: DimensionInputRequest | null;
  pendingConstraintType: ConstraintType | null;

  addPoint: (x: number, y: number) => string;
  addLine: (p1Id: string, p2Id: string) => string;
  addCircle: (centerId: string, radius: number) => string;
  addArc: (centerId: string, startId: string, endId: string) => string;

  applyConstraint: (type: ConstraintType) => { success: boolean; message: string };
  beginConstraintSelection: (type: ConstraintType) => void;
  clearPendingConstraintSelection: () => void;
  submitDimensionInput: (rawValue: string, sourceExpression?: string) => { success: boolean; message: string };
  cancelDimensionInput: () => void;
  requestEditDimension: (constraintId: string) => { success: boolean; message: string };
  updateConstraintParams: (constraintId: string, patch: Record<string, number>) => void;
  removeConstraint: (id: string) => void;
  solveConstraints: () => void;
  dragPoint: (pointId: string, x: number, y: number) => void;

  toggleSelect: (item: SelectionItem, multi: boolean) => void;
  clearSelection: () => void;

  deleteSelected: () => void;
  clearSketch: () => void;
  setStatusMessage: (msg: string) => void;

  loadSketchData: (data: SketchDataSnapshot) => void;
  getSketchData: () => SketchDataSnapshot;

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

function normalizeAngle(a: number): number {
  while (a < 0) a += 2 * Math.PI;
  while (a >= 2 * Math.PI) a -= 2 * Math.PI;
  return a;
}

function isAngleBetween(angle: number, start: number, end: number): boolean {
  const a = normalizeAngle(angle - start);
  const e = normalizeAngle(end - start);
  return a <= e + 1e-6;
}

export const useSketchStore = create<SketchState>((set, get) => ({
  points: INITIAL_SKETCH_SEED.points,
  lines: [],
  circles: [],
  arcs: [],
  constraints: INITIAL_SKETCH_SEED.constraints,
  selection: [],
  statusMessage: '',
  pendingDimensionInput: null,
  pendingConstraintType: null,

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

  addArc: (centerId: string, startId: string, endId: string) => {
    const id = uid();
    const state = get();
    const center = state.points.find((p) => p.id === centerId);
    const start = state.points.find((p) => p.id === startId);
    if (!center || !start) return id;

    const arcConstraintId = uid();
    set((s) => ({
      arcs: [...s.arcs, { id, centerId, startId, endId }],
      constraints: [
        ...s.constraints,
        { id: arcConstraintId, type: 'arcRadius' as ConstraintType, entityIds: [id] },
      ],
    }));
    return id;
  },

  applyConstraint: (type: ConstraintType) => {
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
              circleIdToUpdate: circ.id,
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
        coincident: 'Select 2 points',
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
      };
      const msg = messages[type] || 'Invalid selection';
      set({ statusMessage: msg });
      return { success: false, message: msg };
    }

    const constraintId = uid();
    const newConstraint: SketchConstraint = {
      id: constraintId,
      type,
      entityIds,
      ...(params && { params }),
    };

    set((s) => ({ constraints: [...s.constraints, newConstraint] }));

    get().solveConstraints();

    set({ statusMessage: `${type} constraint applied` });
    return { success: true, message: `${type} constraint applied` };
  },

  beginConstraintSelection: (type: ConstraintType) => {
    const hints: Record<string, string> = {
      fix: 'Select 1 point',
      coincident: 'Select 2 points',
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

    const params: Record<string, number> = { [req.paramKey]: parsed };
    set((s) => {
      const circles = req.circleIdToUpdate
        ? s.circles.map((c) => (c.id === req.circleIdToUpdate ? { ...c, radius: parsed } : c))
        : s.circles;

      if (req.mode === 'edit' && req.constraintId) {
        return {
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
      set({ points: result.points });
    }
  },

  dragPoint: (pointId: string, x: number, y: number) => {
    const state = get();
    const point = state.points.find((p) => p.id === pointId);
    if (!point) return;

    // If there are no constraints, drag directly.
    if (state.constraints.length === 0) {
      set({
        points: state.points.map((p) => (p.id === pointId ? { ...p, x, y } : p)),
      });
      return;
    }

    // Continuation-based drag:
    // solve several small constrained steps toward the cursor each frame.
    // This is much more stable for 1-DoF manifolds than one large solve.
    let working = state.points as SolverPoint[];
    let improved = false;
    let bestEnergy = Number.POSITIVE_INFINITY;
    const maxSubStep = 0.2;
    const maxIters = 12;

    for (let i = 0; i < maxIters; i++) {
      const wp = working.find((p) => p.id === pointId);
      if (!wp) break;
      const dx = x - wp.x;
      const dy = y - wp.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-4) break;

      const step = dist > maxSubStep ? maxSubStep / dist : 1;
      const tx = wp.x + dx * step;
      const ty = wp.y + dy * step;

      const result = solveConstraints(
        working,
        state.lines as SolverLine[],
        state.circles as SolverCircle[],
        state.arcs as SolverArc[],
        state.constraints as SolverConstraint[],
        { pointId, x: tx, y: ty, strength: 0.35 }
      );
      if (result.points.length === 0) break;

      // Keep the best low-energy branch and continue from it.
      if (result.constraintEnergy <= 2e-4 || result.constraintEnergy <= bestEnergy + 1e-6) {
        working = result.points as SolverPoint[];
        bestEnergy = Math.min(bestEnergy, result.constraintEnergy);
        improved = true;
      } else {
        break;
      }
    }

    if (improved && bestEnergy <= 5e-4) {
      set({ points: working as any });
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

    const allDeletedLineIds = new Set(linesToDelete.map((l) => l.id));
    const allDeletedCircleIds = new Set(circlesToDelete.map((c) => c.id));
    const allDeletedArcIds = new Set(arcsToDelete.map((a) => a.id));
    const allDeletedEntityIds = new Set([
      ...selectedPointIds,
      ...allDeletedLineIds,
      ...allDeletedCircleIds,
      ...allDeletedArcIds,
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

    const remainingLines = state.lines.filter((l) => !allDeletedLineIds.has(l.id));
    const remainingCircles = state.circles.filter((c) => !allDeletedCircleIds.has(c.id));
    const remainingArcs = state.arcs.filter((a) => !allDeletedArcIds.has(a.id));

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
      constraints: newConstraints,
      selection: [],
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
      constraints: seeded.constraints,
      selection: [],
      statusMessage: '',
      pendingDimensionInput: null,
      pendingConstraintType: null,
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
      constraints: seeded.constraints,
      selection: [],
      statusMessage: '',
      pendingDimensionInput: null,
      pendingConstraintType: null,
    });
  },

  getSketchData: (): SketchDataSnapshot => {
    const s = get();
    return {
      points: s.points,
      lines: s.lines,
      circles: s.circles,
      arcs: s.arcs,
      constraints: s.constraints,
    };
  },

  findNearestPoint: (x: number, y: number, threshold: number) => {
    const state = get();
    let bestId: string | null = null;
    let bestDist = threshold;
    for (const p of state.points) {
      const d = Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2);
      if (d < bestDist) {
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
      const radius = Math.sqrt((start.x - center.x) ** 2 + (start.y - center.y) ** 2);
      const dc = distToCircle(x, y, center.x, center.y, radius);
      if (dc < bestDist) {
        const angle = Math.atan2(y - center.y, x - center.x);
        const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
        const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
        if (isAngleBetween(angle, startAngle, endAngle)) {
          bestDist = dc;
          best = { type: 'arc', id: a.id };
        }
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
