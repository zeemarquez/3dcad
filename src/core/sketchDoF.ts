/**
 * Degrees-of-freedom visualization for the 2D sketcher (planegcs-backed solves).
 *
 * Uses finite-difference probes + Gram–Schmidt rank on the constraint manifold:
 * for each coordinate direction, apply a small temporary pull via solveConstraints,
 * then measure which independent motions remain. This matches the planegcs solver
 * used for interactive and static solves.
 *
 * Entity colors:
 * - Points: green if their local tangent-space dimension is 0 (fully fixed by constraints).
 * - Lines / arcs: green if every endpoint (and arc center) is fully constrained as a point.
 * - Circles: center point DoF plus one DoF for radius unless a radius/arcRadius dimension locks it.
 *
 * Region fill (whole sketch green): every point is fully constrained, every circle’s radius
 * is locked, every B-spline control point is fully constrained, and the sketch contains at
 * least one non-point entity (line, arc, circle, or B-spline).
 */
import { solveConstraints } from '@/core/planegcsConstraintBridge';
import type {
  SolverArc,
  SolverCircle,
  SolverConstraint,
  SolverLine,
  SolverPoint,
} from '@/core/planegcsConstraintBridge';

export interface SketchDoFInputs {
  points: SolverPoint[];
  lines: SolverLine[];
  circles: SolverCircle[];
  arcs: SolverArc[];
  constraints: SolverConstraint[];
  bsplines: { id: string; controlPointIds: string[] }[];
}

export interface SketchDoFState {
  pointDoF: Map<string, number>;
  lineDoF: Map<string, number>;
  arcDoF: Map<string, number>;
  circleDoF: Map<string, number>;
  /** True when the sketch has no remaining degrees of freedom (see module doc). */
  isSketchFullyConstrained: boolean;
}

const PERTURB = 0.2;
const MOVED_EPS = 1e-3;
const DEP_EPS = 1e-5;
const PROBE_STRENGTH = 0.25;
const PROBE_ITER = 400;

function collectConstrainedPointIds(
  points: SolverPoint[],
  lines: SolverLine[],
  circles: SolverCircle[],
  arcs: SolverArc[],
  constraints: SolverConstraint[]
): Set<string> {
  const pointById = new Map(points.map((p) => [p.id, p]));
  const ids = new Set<string>();
  for (const cn of constraints) {
    for (const eid of cn.entityIds) {
      if (pointById.has(eid)) {
        ids.add(eid);
        continue;
      }
      const l = lines.find((x) => x.id === eid);
      if (l) {
        ids.add(l.p1Id);
        ids.add(l.p2Id);
        continue;
      }
      const c = circles.find((x) => x.id === eid);
      if (c) {
        ids.add(c.centerId);
        continue;
      }
      const a = arcs.find((x) => x.id === eid);
      if (a) {
        ids.add(a.centerId);
        ids.add(a.startId);
        ids.add(a.endId);
      }
    }
  }
  return ids;
}

function gramSchmidtRank(vectors: number[][]): number {
  const basis: number[][] = [];
  for (const v0 of vectors) {
    let v = [...v0];
    for (const b of basis) {
      let dotVB = 0;
      let dotBB = 0;
      for (let i = 0; i < v.length; i++) {
        dotVB += v[i] * b[i];
        dotBB += b[i] * b[i];
      }
      if (dotBB > 0) {
        const s = dotVB / dotBB;
        for (let i = 0; i < v.length; i++) v[i] -= s * b[i];
      }
    }
    let norm2 = 0;
    for (const x of v) norm2 += x * x;
    if (norm2 > DEP_EPS) basis.push(v);
  }
  return basis.length;
}

/**
 * Dimension of the feasible motion subspace projected onto the given point IDs’ coordinates
 * (2 coords per point). Returns 0 when those points are fully determined by constraints.
 */
function estimateEntityTangentRank(
  entityPointIds: string[],
  basePoints: SolverPoint[],
  lines: SolverLine[],
  circles: SolverCircle[],
  arcs: SolverArc[],
  constraints: SolverConstraint[],
  constrainedPointIds: Set<string>
): number {
  const uniq = [...new Set(entityPointIds)];
  if (uniq.length === 0) return 0;

  if (!uniq.some((pid) => constrainedPointIds.has(pid))) {
    return uniq.length * 2;
  }

  const pointById = new Map(basePoints.map((p) => [p.id, p]));
  const baseIdxById = new Map(basePoints.map((p, i) => [p.id, i]));
  const vectors: number[][] = [];

  for (const pid of uniq) {
    const p = pointById.get(pid);
    if (!p) continue;
    for (const axis of ['x', 'y'] as const) {
      const tx = axis === 'x' ? p.x + PERTURB : p.x;
      const ty = axis === 'y' ? p.y + PERTURB : p.y;
      const solved = solveConstraints(
        basePoints,
        lines,
        circles,
        arcs,
        constraints,
        { pointId: pid, x: tx, y: ty, strength: PROBE_STRENGTH },
        PROBE_ITER,
        1
      );

      if (!solved.success) continue;

      const vec: number[] = [];
      let moved = false;
      for (const eid of uniq) {
        const idx = baseIdxById.get(eid);
        if (idx === undefined) continue;
        const b = basePoints[idx];
        const s = solved.points[idx];
        const dx = s.x - b.x;
        const dy = s.y - b.y;
        vec.push(dx, dy);
        if (Math.hypot(dx, dy) > MOVED_EPS) moved = true;
      }
      if (moved) vectors.push(vec);
    }
  }
  return gramSchmidtRank(vectors);
}

function hasRadiusDimensionConstraint(constraints: SolverConstraint[], circleId: string): boolean {
  return constraints.some(
    (cn) => (cn.type === 'radius' || cn.type === 'arcRadius') && cn.entityIds.includes(circleId)
  );
}

export function computeSketchDoFState(input: SketchDoFInputs): SketchDoFState {
  const { points, lines, circles, arcs, constraints, bsplines } = input;

  const emptySketch =
    points.length === 0 &&
    lines.length === 0 &&
    arcs.length === 0 &&
    circles.length === 0 &&
    bsplines.length === 0;

  if (emptySketch) {
    const emptyMaps = () => new Map<string, number>();
    return {
      pointDoF: emptyMaps(),
      lineDoF: emptyMaps(),
      arcDoF: emptyMaps(),
      circleDoF: emptyMaps(),
      isSketchFullyConstrained: false,
    };
  }

  if (constraints.length === 0 || points.length === 0) {
    const pointDoF = new Map<string, number>();
    for (const p of points) pointDoF.set(p.id, 2);
    const lineDoF = new Map<string, number>();
    for (const l of lines) lineDoF.set(l.id, 4);
    const arcDoF = new Map<string, number>();
    for (const a of arcs) arcDoF.set(a.id, 6);
    const circleDoF = new Map<string, number>();
    for (const c of circles) circleDoF.set(c.id, 3);
    return {
      pointDoF,
      lineDoF,
      arcDoF,
      circleDoF,
      isSketchFullyConstrained: false,
    };
  }

  const basePoints = points;
  const constrainedPointIds = collectConstrainedPointIds(points, lines, circles, arcs, constraints);

  const pointDoF = new Map<string, number>();
  for (const p of points) {
    pointDoF.set(
      p.id,
      estimateEntityTangentRank([p.id], basePoints, lines, circles, arcs, constraints, constrainedPointIds)
    );
  }

  const lineDoF = new Map<string, number>();
  for (const l of lines) {
    const d1 = pointDoF.get(l.p1Id) ?? 2;
    const d2 = pointDoF.get(l.p2Id) ?? 2;
    lineDoF.set(l.id, d1 === 0 && d2 === 0 ? 0 : d1 + d2);
  }

  const arcDoF = new Map<string, number>();
  for (const a of arcs) {
    const dc = pointDoF.get(a.centerId) ?? 2;
    const ds = pointDoF.get(a.startId) ?? 2;
    const de = pointDoF.get(a.endId) ?? 2;
    arcDoF.set(a.id, dc === 0 && ds === 0 && de === 0 ? 0 : dc + ds + de);
  }

  const circleDoF = new Map<string, number>();
  for (const c of circles) {
    const centerDof = pointDoF.get(c.centerId) ?? 2;
    const radiusLocked = hasRadiusDimensionConstraint(constraints, c.id);
    const radiusDof = radiusLocked ? 0 : 1;
    circleDoF.set(c.id, centerDof + radiusDof);
  }

  const hasNonPointGeometry =
    lines.length > 0 || arcs.length > 0 || circles.length > 0 || bsplines.length > 0;

  const everyPointFixed = points.every((p) => pointDoF.get(p.id) === 0);
  const everyCircleFixed = circles.every((c) => circleDoF.get(c.id) === 0);
  const everyBsplineControlFixed = bsplines.every((b) =>
    b.controlPointIds.every((pid) => pointDoF.get(pid) === 0)
  );

  const isSketchFullyConstrained =
    hasNonPointGeometry &&
    everyPointFixed &&
    everyCircleFixed &&
    everyBsplineControlFixed;

  return {
    pointDoF,
    lineDoF,
    arcDoF,
    circleDoF,
    isSketchFullyConstrained,
  };
}
