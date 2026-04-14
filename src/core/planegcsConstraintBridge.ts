/**
 * Bridge from the sketch app's constraint model to the FreeCAD planegcs solver
 * (@salusoft89/planegcs, https://github.com/Salusoft89/planegcs).
 *
 * Static solves and interactive drags both use planegcs. Drags add temporary
 * `coordinate_x` / `coordinate_y` constraints toward the cursor (soft pull when
 * other constraints conflict; planegcs switches to SQP when temporaries are present).
 */
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { init_planegcs_module, GcsWrapper, Algorithm, SolveStatus } from '@salusoft89/planegcs';
import type { SketchPrimitive } from '@salusoft89/planegcs';
import { arcSignedSweep } from '@/core/sketchArcPoints';
import type {
  DragTarget,
  SolveResult,
  SolverArc,
  SolverCircle,
  SolverConstraint,
  SolverLine,
  SolverPoint,
} from '@/core/constraintSolver';

export type {
  DragTarget,
  SolveResult,
  SolverArc,
  SolverCircle,
  SolverConstraint,
  SolverLine,
  SolverPoint,
} from '@/core/constraintSolver';

const REF_ORIGIN_ID = '__ref_origin__';
const REF_X_AXIS_ID = '__ref_x_axis__';
const REF_Y_AXIS_ID = '__ref_y_axis__';
const REF_XA_P1 = '__ref_xa_p1__';
const REF_XA_P2 = '__ref_xa_p2__';
const REF_YA_P1 = '__ref_ya_p1__';
const REF_YA_P2 = '__ref_ya_p2__';

const mod = await init_planegcs_module({ locateFile: () => wasmUrl });
const gcsWrapper = new GcsWrapper(new mod.GcsSystem());

function nextConstraintId(): string {
  return `__pgcs_c_${Math.random().toString(36).slice(2, 11)}_${Date.now().toString(36)}`;
}

function collectRefPointIds(
  points: SolverPoint[],
  lines: SolverLine[],
  circles: SolverCircle[],
  arcs: SolverArc[],
  constraints: SolverConstraint[],
  dragTarget?: DragTarget
): Set<string> {
  const pointById = new Map(points.map((p) => [p.id, p]));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const circleById = new Map(circles.map((c) => [c.id, c]));
  const arcById = new Map(arcs.map((a) => [a.id, a]));

  pointById.set(REF_ORIGIN_ID, { id: REF_ORIGIN_ID, x: 0, y: 0 });
  pointById.set(REF_XA_P1, { id: REF_XA_P1, x: -10000, y: 0 });
  pointById.set(REF_XA_P2, { id: REF_XA_P2, x: 10000, y: 0 });
  pointById.set(REF_YA_P1, { id: REF_YA_P1, x: 0, y: -10000 });
  pointById.set(REF_YA_P2, { id: REF_YA_P2, x: 0, y: 10000 });
  lineById.set(REF_X_AXIS_ID, { id: REF_X_AXIS_ID, p1Id: REF_XA_P1, p2Id: REF_XA_P2 });
  lineById.set(REF_Y_AXIS_ID, { id: REF_Y_AXIS_ID, p1Id: REF_YA_P1, p2Id: REF_YA_P2 });

  const refPointIds = new Set<string>();
  for (const c of constraints) {
    for (const eid of c.entityIds) {
      if (pointById.has(eid)) refPointIds.add(eid);
      else if (lineById.has(eid)) {
        const line = lineById.get(eid)!;
        refPointIds.add(line.p1Id);
        refPointIds.add(line.p2Id);
      } else if (circleById.has(eid)) refPointIds.add(circleById.get(eid)!.centerId);
      else if (arcById.has(eid)) {
        const arc = arcById.get(eid)!;
        refPointIds.add(arc.centerId);
        refPointIds.add(arc.startId);
        refPointIds.add(arc.endId);
      }
    }
  }
  if (dragTarget && pointById.has(dragTarget.pointId)) refPointIds.add(dragTarget.pointId);
  return refPointIds;
}

function arcAngles(
  center: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
  complementaryArc?: boolean
): { start_angle: number; end_angle: number; radius: number } {
  const dx = start.x - center.x;
  const dy = start.y - center.y;
  const radius = Math.hypot(dx, dy);
  const a0 = Math.atan2(dy, dx);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const sweep = arcSignedSweep(a0, a1, complementaryArc);
  return { start_angle: a0, end_angle: a0 + sweep, radius };
}

function buildPlanegcsPrimitives(
  pointById: Map<string, SolverPoint>,
  lineById: Map<string, SolverLine>,
  circleById: Map<string, SolverCircle>,
  arcById: Map<string, SolverArc>,
  pIds: string[],
  constraints: SolverConstraint[],
  fixedPointIds: Set<string>
): SketchPrimitive[] {
  const out: SketchPrimitive[] = [];

  for (const pid of pIds) {
    const p = pointById.get(pid);
    if (!p) continue;
    const fixed = fixedPointIds.has(pid);
    out.push({ id: pid, type: 'point', x: p.x, y: p.y, fixed });
  }

  const lineIds = new Set<string>();
  const circleIds = new Set<string>();
  const arcIds = new Set<string>();
  for (const c of constraints) {
    for (const eid of c.entityIds) {
      if (lineById.has(eid)) lineIds.add(eid);
      if (circleById.has(eid)) circleIds.add(eid);
      if (arcById.has(eid)) arcIds.add(eid);
    }
  }

  for (const lid of lineIds) {
    const l = lineById.get(lid);
    if (l) out.push({ id: lid, type: 'line', p1_id: l.p1Id, p2_id: l.p2Id });
  }
  for (const cid of circleIds) {
    const circ = circleById.get(cid);
    if (circ) out.push({ id: cid, type: 'circle', c_id: circ.centerId, radius: circ.radius });
  }
  for (const aid of arcIds) {
    const a = arcById.get(aid);
    if (!a) continue;
    const c = pointById.get(a.centerId);
    const s = pointById.get(a.startId);
    const e = pointById.get(a.endId);
    if (!c || !s || !e) continue;
    const { start_angle, end_angle, radius } = arcAngles(c, s, e, a.complementaryArc);
    out.push({
      id: aid,
      type: 'arc',
      c_id: a.centerId,
      radius,
      start_angle,
      end_angle,
      start_id: a.startId,
      end_id: a.endId,
    });
    out.push({ id: `${aid}__arc_rules`, type: 'arc_rules', a_id: aid });
  }

  const pushC = (o: SketchPrimitive) => {
    out.push(o);
  };

  for (const c of constraints) {
    const { type, entityIds: e, params } = c;
    const id = c.id || nextConstraintId();

    switch (type) {
      case 'fix':
        break;
      case 'coincident':
        pushC({ id, type: 'p2p_coincident', p1_id: e[0], p2_id: e[1] });
        break;
      case 'horizontal':
        pushC({ id, type: 'horizontal_l', l_id: e[0] });
        break;
      case 'vertical':
        pushC({ id, type: 'vertical_l', l_id: e[0] });
        break;
      case 'equal':
        pushC({ id, type: 'equal_length', l1_id: e[0], l2_id: e[1] });
        break;
      case 'parallel':
        pushC({ id, type: 'parallel', l1_id: e[0], l2_id: e[1] });
        break;
      case 'perpendicular':
        pushC({ id, type: 'perpendicular_ll', l1_id: e[0], l2_id: e[1] });
        break;
      case 'tangent': {
        const lineEnt = lineById.has(e[0]) ? e[0] : e[1];
        const curveEnt = circleById.has(e[0]) || arcById.has(e[0]) ? e[0] : e[1];
        if (circleById.has(curveEnt)) pushC({ id, type: 'tangent_lc', l_id: lineEnt, c_id: curveEnt });
        else if (arcById.has(curveEnt)) pushC({ id, type: 'tangent_la', l_id: lineEnt, a_id: curveEnt });
        break;
      }
      case 'concentric': {
        const c0 = circleById.has(e[0]) ? circleById.get(e[0]) : undefined;
        const a0 = arcById.has(e[0]) ? arcById.get(e[0]) : undefined;
        const c1 = circleById.has(e[1]) ? circleById.get(e[1]) : undefined;
        const a1 = arcById.has(e[1]) ? arcById.get(e[1]) : undefined;
        const p0 = c0?.centerId ?? a0?.centerId;
        const p1 = c1?.centerId ?? a1?.centerId;
        if (p0 && p1) pushC({ id, type: 'p2p_coincident', p1_id: p0, p2_id: p1 });
        break;
      }
      case 'midpoint': {
        const line = lineById.get(e[0]);
        const pid = e[1];
        if (line) {
          pushC({ id: `${id}_pol`, type: 'point_on_line_pl', p_id: pid, l_id: line.id });
          pushC({
            id: `${id}_pob`,
            type: 'point_on_perp_bisector_ppp',
            p_id: pid,
            lp1_id: line.p1Id,
            lp2_id: line.p2Id,
          });
        }
        break;
      }
      case 'pointOnLine':
        pushC({ id, type: 'point_on_line_pl', p_id: e[1], l_id: e[0] });
        break;
      case 'distance': {
        const dist = params?.distance ?? 0;
        const p0 = pointById.get(e[0]);
        const p1 = pointById.get(e[1]);
        if (p0 && p1) pushC({ id, type: 'p2p_distance', p1_id: p0.id, p2_id: p1.id, distance: dist });
        else {
          const line = lineById.get(e[0]);
          if (line)
            pushC({
              id,
              type: 'p2p_distance',
              p1_id: line.p1Id,
              p2_id: line.p2Id,
              distance: dist,
            });
        }
        break;
      }
      case 'length': {
        const line = lineById.get(e[0]);
        const dist = params?.distance ?? 0;
        if (line)
          pushC({
            id,
            type: 'p2p_distance',
            p1_id: line.p1Id,
            p2_id: line.p2Id,
            distance: dist,
          });
        break;
      }
      case 'horizontalDistance': {
        const dist = params?.distance ?? 0;
        pushC({
          id,
          type: 'difference',
          param1: { o_id: e[1], prop: 'x' },
          param2: { o_id: e[0], prop: 'x' },
          difference: dist,
        });
        break;
      }
      case 'verticalDistance': {
        const dist = params?.distance ?? 0;
        pushC({
          id,
          type: 'difference',
          param1: { o_id: e[1], prop: 'y' },
          param2: { o_id: e[0], prop: 'y' },
          difference: dist,
        });
        break;
      }
      case 'radius': {
        const arc = arcById.get(e[0]);
        const circ = circleById.get(e[0]);
        const r = params?.radius ?? 0;
        if (circ) pushC({ id, type: 'circle_radius', c_id: circ.id, radius: r });
        else if (arc) pushC({ id, type: 'arc_radius', a_id: arc.id, radius: r });
        break;
      }
      case 'angle': {
        const rad = ((params?.angle ?? 90) * Math.PI) / 180;
        pushC({ id, type: 'l2l_angle_ll', l1_id: e[0], l2_id: e[1], angle: rad });
        break;
      }
      case 'symmetry': {
        const axisLine = lineById.get(e[0]);
        if (!axisLine) break;
        const idA = e[1];
        const idB = e[2];
        const swapB = (params?.swapLineBEndpoints ?? 0) !== 0;

        if (pointById.has(idA) && pointById.has(idB)) {
          pushC({
            id,
            type: 'p2p_symmetric_ppl',
            p1_id: idA,
            p2_id: idB,
            l_id: axisLine.id,
          });
          break;
        }
        const lineA = lineById.get(idA);
        const lineB = lineById.get(idB);
        if (lineA && lineB) {
          const bP1 = swapB ? lineB.p2Id : lineB.p1Id;
          const bP2 = swapB ? lineB.p1Id : lineB.p2Id;
          pushC({
            id: `${id}_s1`,
            type: 'p2p_symmetric_ppl',
            p1_id: lineA.p1Id,
            p2_id: bP1,
            l_id: axisLine.id,
          });
          pushC({
            id: `${id}_s2`,
            type: 'p2p_symmetric_ppl',
            p1_id: lineA.p2Id,
            p2_id: bP2,
            l_id: axisLine.id,
          });
          break;
        }
        const circA = circleById.get(idA);
        const circB = circleById.get(idB);
        if (circA && circB) {
          pushC({
            id,
            type: 'p2p_symmetric_ppl',
            p1_id: circA.centerId,
            p2_id: circB.centerId,
            l_id: axisLine.id,
          });
          break;
        }
        const arcA = arcById.get(idA);
        const arcB = arcById.get(idB);
        if (arcA && arcB) {
          pushC({
            id: `${id}_a1`,
            type: 'p2p_symmetric_ppl',
            p1_id: arcA.centerId,
            p2_id: arcB.centerId,
            l_id: axisLine.id,
          });
          pushC({
            id: `${id}_a2`,
            type: 'p2p_symmetric_ppl',
            p1_id: arcA.startId,
            p2_id: arcB.startId,
            l_id: axisLine.id,
          });
          pushC({
            id: `${id}_a3`,
            type: 'p2p_symmetric_ppl',
            p1_id: arcA.endId,
            p2_id: arcB.endId,
            l_id: axisLine.id,
          });
        }
        break;
      }
      case 'arcRadius': {
        const arc = arcById.get(e[0]);
        if (arc) {
          const c = pointById.get(arc.centerId);
          const s = pointById.get(arc.startId);
          if (c && s) {
            const r = Math.hypot(s.x - c.x, s.y - c.y);
            pushC({ id, type: 'arc_radius', a_id: arc.id, radius: r });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return out;
}

/** Scale for temporary cursor constraints; higher = stronger pull toward (x,y). */
function dragCursorConstraintScale(dragTarget: DragTarget, constraintScale?: number): number {
  const w = dragTarget.strength ?? 10;
  const cs = constraintScale ?? 1;
  return Math.min(1e6, Math.max(1e-4, w * cs * 10));
}

function appendTemporaryDragConstraints(
  primitives: SketchPrimitive[],
  dragTarget: DragTarget,
  constraintScale?: number
): void {
  const scale = dragCursorConstraintScale(dragTarget, constraintScale);
  primitives.push({
    id: nextConstraintId(),
    type: 'coordinate_x',
    p_id: dragTarget.pointId,
    x: dragTarget.x,
    temporary: true,
    driving: true,
    scale,
  });
  primitives.push({
    id: nextConstraintId(),
    type: 'coordinate_y',
    p_id: dragTarget.pointId,
    y: dragTarget.y,
    temporary: true,
    driving: true,
    scale,
  });
}

export function solveConstraints(
  points: SolverPoint[],
  lines: SolverLine[],
  circles: SolverCircle[],
  arcs: SolverArc[],
  constraints: SolverConstraint[],
  dragTarget?: DragTarget,
  maxLBFGSIter?: number,
  constraintScale?: number
): SolveResult {
  if (constraints.length === 0 || points.length === 0) {
    return { success: true, points, iterations: 0, energy: 0, constraintEnergy: 0, dragEnergy: 0 };
  }

  const pointById = new Map(points.map((p) => [p.id, p]));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const circleById = new Map(circles.map((c) => [c.id, c]));
  const arcById = new Map(arcs.map((a) => [a.id, a]));

  pointById.set(REF_ORIGIN_ID, { id: REF_ORIGIN_ID, x: 0, y: 0 });
  pointById.set(REF_XA_P1, { id: REF_XA_P1, x: -10000, y: 0 });
  pointById.set(REF_XA_P2, { id: REF_XA_P2, x: 10000, y: 0 });
  pointById.set(REF_YA_P1, { id: REF_YA_P1, x: 0, y: -10000 });
  pointById.set(REF_YA_P2, { id: REF_YA_P2, x: 0, y: 10000 });
  lineById.set(REF_X_AXIS_ID, { id: REF_X_AXIS_ID, p1Id: REF_XA_P1, p2Id: REF_XA_P2 });
  lineById.set(REF_Y_AXIS_ID, { id: REF_Y_AXIS_ID, p1Id: REF_YA_P1, p2Id: REF_YA_P2 });

  const refPointIds = collectRefPointIds(points, lines, circles, arcs, constraints, dragTarget);
  const pIds = [...refPointIds].sort();

  if (pIds.length === 0) {
    return { success: true, points, iterations: 0, energy: 0, constraintEnergy: 0, dragEnergy: 0 };
  }

  const fixedPointIds = new Set<string>();
  for (const c of constraints) {
    if (c.type === 'fix' && c.entityIds[0]) fixedPointIds.add(c.entityIds[0]);
  }
  for (const vpid of [REF_ORIGIN_ID, REF_XA_P1, REF_XA_P2, REF_YA_P1, REF_YA_P2]) {
    if (pIds.includes(vpid)) fixedPointIds.add(vpid);
  }

  const effectiveConstraints: SolverConstraint[] = [...constraints];
  for (const vpid of [REF_ORIGIN_ID, REF_XA_P1, REF_XA_P2, REF_YA_P1, REF_YA_P2]) {
    if (pIds.includes(vpid)) {
      const vp = pointById.get(vpid)!;
      effectiveConstraints.push({
        id: `fix_${vpid}`,
        type: 'fix',
        entityIds: [vpid],
        params: { x: vp.x, y: vp.y },
      });
    }
  }

  const primitives = buildPlanegcsPrimitives(
    pointById,
    lineById,
    circleById,
    arcById,
    pIds,
    effectiveConstraints,
    fixedPointIds
  );

  if (dragTarget && pointById.has(dragTarget.pointId) && !fixedPointIds.has(dragTarget.pointId)) {
    appendTemporaryDragConstraints(primitives, dragTarget, constraintScale);
  }

  gcsWrapper.clear_data();
  gcsWrapper.set_max_iterations(maxLBFGSIter ?? (dragTarget ? 120 : 200));
  gcsWrapper.set_convergence_threshold(1e-10);
  gcsWrapper.push_primitives_and_params(primitives);

  const status = gcsWrapper.solve(Algorithm.DogLeg);
  gcsWrapper.apply_solution();

  const solved = gcsWrapper.sketch_index.get_primitives();
  const solvedPoints = new Map<string, { x: number; y: number }>();
  for (const p of solved) {
    if (p.type === 'point') solvedPoints.set(p.id, { x: p.x, y: p.y });
  }

  const ok =
    (status === SolveStatus.Success || status === SolveStatus.Converged) &&
    !gcsWrapper.has_gcs_conflicting_constraints();

  const newPoints = points.map((p) => {
    const sp = solvedPoints.get(p.id);
    return sp ? { ...p, x: sp.x, y: sp.y } : p;
  });

  let dragEnergy = 0;
  if (dragTarget && !fixedPointIds.has(dragTarget.pointId)) {
    const sp = solvedPoints.get(dragTarget.pointId);
    if (sp) {
      const w = dragTarget.strength ?? 0.1;
      const dx = sp.x - dragTarget.x;
      const dy = sp.y - dragTarget.y;
      dragEnergy = w * (dx * dx + dy * dy);
    }
  }

  const constraintEnergy = ok ? 0 : 1;
  return {
    success: ok,
    points: newPoints,
    iterations: 0,
    energy: constraintEnergy + dragEnergy,
    constraintEnergy,
    dragEnergy,
  };
}
