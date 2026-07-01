/**
 * Degrees-of-freedom visualization for the 2D sketcher (planegcs-backed solves).
 *
 * For each probed point we central-difference along the sketch x/y axes: the point's initial
 * position is perturbed by ±Δ, the solver is re-run WITHOUT any temporary drag constraint,
 * and the residual displacements (solved − original) are averaged as `v = (v₊ − v₋) / 2`.
 * This cancels the second-order curvature term of the constraint manifold so the resulting
 * vectors are clean tangent directions; their count under Gram–Schmidt is the point's local
 * DoF.
 *
 * This avoids the pitfall of probing via a hard `coordinate_x`/`coordinate_y` driving
 * constraint: those constraints do not honour a `scale` (see planegcs
 * `constraint_param_index.coordinate_x`), so such a probe is enforced as a hard equality
 * and fails with a GCS conflict whenever the target lies off the manifold. In that failure
 * mode the probe yields zero vectors for both axes and the point is falsely reported as
 * fully constrained (green).
 *
 * Entity colors:
 * - Points: green if the probe shows zero independent tangent directions at that point.
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

const PERTURB = 0.25;
/** Motion below this fraction of PERTURB is considered "pulled back" (no DoF along that axis). */
const MOVED_REL_EPS = 0.05;
/** Gram–Schmidt dependency threshold, as a fraction of PERTURB. */
const DEP_REL_EPS = 0.02;
const PROBE_ITER = 200;

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

function collectFixedPointIds(constraints: SolverConstraint[]): Set<string> {
  const ids = new Set<string>();
  for (const c of constraints) {
    if (c.type === 'fix' && c.entityIds.length >= 1) ids.add(c.entityIds[0]);
  }
  return ids;
}

function gramSchmidtRank(vectors: number[][], depTol: number): number {
  const basis: number[][] = [];
  for (const v0 of vectors) {
    const v = [...v0];
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
    let norm = 0;
    for (const x of v) norm += x * x;
    if (Math.sqrt(norm) > depTol) basis.push(v);
  }
  return basis.length;
}

/**
 * Perturb the point's initial position by (dx, dy), re-solve without any drag target, and
 * return the residual displacement of each entity point (solved − base). Returns undefined
 * when the solver produced no usable result.
 */
function probeResidualMotion(
  pid: string,
  dx: number,
  dy: number,
  entityPointIds: string[],
  basePoints: SolverPoint[],
  lines: SolverLine[],
  circles: SolverCircle[],
  arcs: SolverArc[],
  constraints: SolverConstraint[],
  baseIdxById: Map<string, number>
): number[] | undefined {
  const perturbed = basePoints.map((p) =>
    p.id === pid ? { ...p, x: p.x + dx, y: p.y + dy } : p
  );
  const solved = solveConstraints(
    perturbed,
    lines,
    circles,
    arcs,
    constraints,
    undefined,
    PROBE_ITER,
    1
  );
  // Only trust a converged, conflict-free solve: `solveConstraints` always echoes back the
  // full points array (so `.length` is never 0), but on a failed/over-constrained solve the
  // coordinates are unreliable and must not be fed into the tangent-rank estimate — otherwise
  // a point can be mis-painted green (fully constrained) when it still floats, and vice versa.
  if (!solved.success || !solved.points.length) return undefined;

  const solvedById = new Map(solved.points.map((p) => [p.id, p]));
  const vec: number[] = [];
  for (const eid of entityPointIds) {
    const idx = baseIdxById.get(eid);
    if (idx === undefined) {
      vec.push(0, 0);
      continue;
    }
    const b = basePoints[idx];
    const s = solvedById.get(eid);
    if (!s) {
      // Point was not included in the solve (not referenced by any constraint). It stays put.
      vec.push(0, 0);
      continue;
    }
    vec.push(s.x - b.x, s.y - b.y);
  }
  return vec;
}

/**
 * Dimension of the feasible motion subspace projected onto the given point IDs' coordinates
 * (2 coords per point). Returns 0 when those points are fully determined by constraints.
 */
function estimateEntityTangentRank(
  entityPointIds: string[],
  basePoints: SolverPoint[],
  lines: SolverLine[],
  circles: SolverCircle[],
  arcs: SolverArc[],
  constraints: SolverConstraint[],
  constrainedPointIds: Set<string>,
  fixedPointIds: Set<string>
): number {
  const uniq = [...new Set(entityPointIds)];
  if (uniq.length === 0) return 0;

  if (uniq.every((pid) => fixedPointIds.has(pid))) return 0;

  if (!uniq.some((pid) => constrainedPointIds.has(pid))) {
    return uniq.length * 2;
  }

  const baseIdxById = new Map(basePoints.map((p, i) => [p.id, i]));
  const vectors: number[][] = [];

  const movedEps = PERTURB * MOVED_REL_EPS;
  const depTol = PERTURB * DEP_REL_EPS;

  for (const pid of uniq) {
    if (!basePoints.some((p) => p.id === pid)) continue;
    // A directly pinned point contributes no local tangent by construction.
    if (fixedPointIds.has(pid)) continue;

    for (const axis of ['x', 'y'] as const) {
      const dxPos = axis === 'x' ? PERTURB : 0;
      const dyPos = axis === 'y' ? PERTURB : 0;
      const vecPos = probeResidualMotion(
        pid,
        dxPos,
        dyPos,
        uniq,
        basePoints,
        lines,
        circles,
        arcs,
        constraints,
        baseIdxById
      );
      const vecNeg = probeResidualMotion(
        pid,
        -dxPos,
        -dyPos,
        uniq,
        basePoints,
        lines,
        circles,
        arcs,
        constraints,
        baseIdxById
      );
      // Central difference: the second-order curvature term is even in Δ and cancels here,
      // so for a genuinely 1D manifold the ± residuals give colinear vectors instead of a
      // spurious 2D pair (which would inflate the rank).
      let vec: number[] | undefined;
      if (vecPos && vecNeg) {
        vec = vecPos.map((v, i) => 0.5 * (v - vecNeg[i]));
      } else if (vecPos) {
        vec = vecPos;
      } else if (vecNeg) {
        vec = vecNeg.map((v) => -v);
      }
      if (!vec) continue;

      let magnitudeSq = 0;
      for (const v of vec) magnitudeSq += v * v;
      const magnitude = Math.sqrt(magnitudeSq);
      if (magnitude <= movedEps) continue;

      vectors.push(vec);
    }
  }

  const rank = gramSchmidtRank(vectors, depTol);
  return Math.min(rank, uniq.length * 2);
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
  const fixedPointIds = collectFixedPointIds(constraints);

  const pointDoF = new Map<string, number>();
  for (const p of points) {
    pointDoF.set(
      p.id,
      estimateEntityTangentRank(
        [p.id],
        basePoints,
        lines,
        circles,
        arcs,
        constraints,
        constrainedPointIds,
        fixedPointIds
      )
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
