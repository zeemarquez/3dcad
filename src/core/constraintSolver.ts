export interface SolverPoint { id: string; x: number; y: number; }
export interface SolverLine { id: string; p1Id: string; p2Id: string; }
export interface SolverCircle { id: string; centerId: string; radius: number; }
export interface SolverArc {
  id: string;
  centerId: string;
  startId: string;
  endId: string;
  /** When set, arc uses the major branch between start/end (see sketchArcPoints). */
  complementaryArc?: boolean;
}

export interface SolverConstraint {
  id: string;
  type: string;
  entityIds: string[];
  params?: Record<string, number>;
}

export interface SolveResult {
  success: boolean;
  points: SolverPoint[];
  iterations: number;
  energy: number;
  constraintEnergy: number;
  dragEnergy: number;
}

export interface DragTarget {
  pointId: string;
  x: number;
  y: number;
  strength?: number;
}

const REF_ORIGIN_ID = "__ref_origin__";
const REF_X_AXIS_ID = "__ref_x_axis__";
const REF_Y_AXIS_ID = "__ref_y_axis__";
const REF_XA_P1 = "__ref_xa_p1__";
const REF_XA_P2 = "__ref_xa_p2__";
const REF_YA_P1 = "__ref_ya_p1__";
const REF_YA_P2 = "__ref_ya_p2__";

function lbfgsSolve(
  x0: number[],
  energyFn: (x: number[]) => number,
  gradientFn: (x: number[], out: number[]) => void,
  maxIter = 200,
  tol = 1e-10,
  energyTol = 1e-8
): { x: number[]; iterations: number; energy: number } {
  const n = x0.length;
  if (n === 0) return { x: [], iterations: 0, energy: 0 };

  const m = 8;
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = x0[i];

  // Pre-allocated ring buffer for L-BFGS history — zero allocations in the hot loop.
  const sRing: number[][] = [];
  const yRing: number[][] = [];
  for (let i = 0; i < m; i++) {
    sRing.push(new Array<number>(n));
    yRing.push(new Array<number>(n));
  }
  const rhoRing = new Array<number>(m);
  let histLen = 0;
  let histStart = 0;

  const alpha = new Array<number>(m);
  const q = new Array<number>(n);
  const dir = new Array<number>(n);
  const xNew = new Array<number>(n);
  const prevG = new Array<number>(n);
  const g = new Array<number>(n);
  for (let i = 0; i < n; i++) g[i] = 0;

  gradientFn(x, g);
  let fx = energyFn(x);

  for (let iter = 0; iter < maxIter; iter++) {
    let gNorm = 0;
    for (let i = 0; i < n; i++) gNorm += g[i] * g[i];
    if (gNorm < 1e-12) {
      return { x, iterations: iter, energy: fx };
    }

    for (let i = 0; i < n; i++) q[i] = g[i];
    const k = histLen;

    for (let i = k - 1; i >= 0; i--) {
      const ri = (histStart + i) % m;
      let d = 0;
      const sr = sRing[ri];
      for (let j = 0; j < n; j++) d += sr[j] * q[j];
      alpha[i] = rhoRing[ri] * d;
      const yr = yRing[ri];
      for (let j = 0; j < n; j++) q[j] -= alpha[i] * yr[j];
    }

    for (let i = 0; i < n; i++) dir[i] = q[i];
    if (k > 0) {
      const lastRi = (histStart + k - 1) % m;
      const sLast = sRing[lastRi], yLast = yRing[lastRi];
      let sy = 0, yy = 0;
      for (let j = 0; j < n; j++) { sy += sLast[j] * yLast[j]; yy += yLast[j] * yLast[j]; }
      if (yy > 1e-30) {
        const gamma = sy / yy;
        for (let j = 0; j < n; j++) dir[j] = q[j] * gamma;
      }
    }

    for (let i = 0; i < k; i++) {
      const ri = (histStart + i) % m;
      const yr = yRing[ri];
      let d = 0;
      for (let j = 0; j < n; j++) d += yr[j] * dir[j];
      const beta = rhoRing[ri] * d;
      const sr = sRing[ri];
      for (let j = 0; j < n; j++) dir[j] += (alpha[i] - beta) * sr[j];
    }

    for (let j = 0; j < n; j++) dir[j] = -dir[j];

    let gd = 0;
    for (let j = 0; j < n; j++) gd += g[j] * dir[j];
    if (gd >= 0) {
      for (let j = 0; j < n; j++) dir[j] = -g[j];
      gd = 0;
      for (let j = 0; j < n; j++) gd += g[j] * dir[j];
    }

    let step = 1.0;
    const c1 = 1e-4;
    for (let ls = 0; ls < 12; ls++) {
      for (let j = 0; j < n; j++) xNew[j] = x[j] + step * dir[j];
      if (energyFn(xNew) <= fx + c1 * step * gd) break;
      step *= 0.5;
    }

    for (let j = 0; j < n; j++) prevG[j] = g[j];
    for (let j = 0; j < n; j++) x[j] += step * dir[j];

    const newFx = energyFn(x);
    for (let i = 0; i < n; i++) g[i] = 0;
    gradientFn(x, g);

    // Compute s = step*dir and y = g_new - g_old into temp buffers (dir/prevG are
    // free — they won't be read again until next iteration overwrites them).
    let sy = 0;
    for (let j = 0; j < n; j++) {
      const sj = step * dir[j];
      const yj = g[j] - prevG[j];
      dir[j] = sj;
      prevG[j] = yj;
      sy += sj * yj;
    }
    if (sy > 1e-16) {
      const slot = histLen < m ? histLen : histStart;
      const sSlot = sRing[slot], ySlot = yRing[slot];
      for (let j = 0; j < n; j++) { sSlot[j] = dir[j]; ySlot[j] = prevG[j]; }
      rhoRing[slot] = 1 / sy;
      if (histLen < m) histLen++;
      else histStart = (histStart + 1) % m;
    }

    // Two termination gates:
    // 1) Energy is near zero AND improvement stalled — clean convergence.
    // 2) Relative improvement is negligible (stagnated at any energy level) —
    //    the solver reached a local minimum and more iterations won't help.
    //    Gate (2) uses a relative check to avoid premature exit on the first
    //    slow iteration; it only fires after several tiny steps in a row.
    if (newFx < energyTol && Math.abs(newFx - fx) < tol) {
      return { x, iterations: iter + 1, energy: newFx };
    }
    if (Math.abs(newFx - fx) < tol * (1 + Math.abs(newFx))) {
      return { x, iterations: iter + 1, energy: newFx };
    }

    fx = newFx;
  }

  return { x, iterations: maxIter, energy: fx };
}

type EFn = (x: number[]) => number;
type GFn = (x: number[], g: number[]) => void;

function registerConstraint(
  constraint: SolverConstraint,
  pointById: Map<string, SolverPoint>,
  lineById: Map<string, SolverLine>,
  circleById: Map<string, SolverCircle>,
  arcById: Map<string, SolverArc>,
  pIdx: Map<string, number>,
  eFns: EFn[],
  gFns: GFn[]
): void {
  const { type, entityIds, params } = constraint;
  const FIX_WEIGHT = 1e6;

  switch (type) {
    case 'fix': {
      const pid = entityIds[0];
      const idx = pIdx.get(pid);
      if (idx === undefined) return;
      const tx = params?.x ?? pointById.get(pid)!.x;
      const ty = params?.y ?? pointById.get(pid)!.y;
      eFns.push((x) => {
        const dx = x[idx] - tx, dy = x[idx + 1] - ty;
        return FIX_WEIGHT * (dx * dx + dy * dy);
      });
      gFns.push((x, g) => {
        g[idx] += FIX_WEIGHT * 2 * (x[idx] - tx);
        g[idx + 1] += FIX_WEIGHT * 2 * (x[idx + 1] - ty);
      });
      break;
    }

    case 'coincident': {
      const i0 = pIdx.get(entityIds[0]);
      const i1 = pIdx.get(entityIds[1]);
      if (i0 === undefined || i1 === undefined) return;
      eFns.push((x) => {
        const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1];
        return dx * dx + dy * dy;
      });
      gFns.push((x, g) => {
        const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1];
        g[i0] += -2 * dx; g[i0 + 1] += -2 * dy;
        g[i1] += 2 * dx;  g[i1 + 1] += 2 * dy;
      });
      break;
    }

    case 'horizontal': {
      const line = lineById.get(entityIds[0]);
      if (!line) return;
      const i0 = pIdx.get(line.p1Id), i1 = pIdx.get(line.p2Id);
      if (i0 === undefined || i1 === undefined) return;
      eFns.push((x) => {
        const dy = x[i0 + 1] - x[i1 + 1];
        return dy * dy;
      });
      gFns.push((x, g) => {
        const dy = x[i0 + 1] - x[i1 + 1];
        g[i0 + 1] += 2 * dy;
        g[i1 + 1] += -2 * dy;
      });
      break;
    }

    case 'vertical': {
      const line = lineById.get(entityIds[0]);
      if (!line) return;
      const i0 = pIdx.get(line.p1Id), i1 = pIdx.get(line.p2Id);
      if (i0 === undefined || i1 === undefined) return;
      eFns.push((x) => {
        const dx = x[i0] - x[i1];
        return dx * dx;
      });
      gFns.push((x, g) => {
        const dx = x[i0] - x[i1];
        g[i0] += 2 * dx;
        g[i1] += -2 * dx;
      });
      break;
    }

    case 'equal': {
      const l1 = lineById.get(entityIds[0]), l2 = lineById.get(entityIds[1]);
      if (!l1 || !l2) return;
      const ia = pIdx.get(l1.p1Id), ib = pIdx.get(l1.p2Id);
      const ic = pIdx.get(l2.p1Id), id = pIdx.get(l2.p2Id);
      if (ia === undefined || ib === undefined || ic === undefined || id === undefined) return;
      eFns.push((x) => {
        const u1 = x[ib] - x[ia], v1 = x[ib + 1] - x[ia + 1];
        const u2 = x[id] - x[ic], v2 = x[id + 1] - x[ic + 1];
        const h = u1 * u1 + v1 * v1 - u2 * u2 - v2 * v2;
        return h * h;
      });
      gFns.push((x, g) => {
        const u1 = x[ib] - x[ia], v1 = x[ib + 1] - x[ia + 1];
        const u2 = x[id] - x[ic], v2 = x[id + 1] - x[ic + 1];
        const h = u1 * u1 + v1 * v1 - u2 * u2 - v2 * v2;
        g[ia] += 2 * h * (-2 * u1);       g[ia + 1] += 2 * h * (-2 * v1);
        g[ib] += 2 * h * (2 * u1);        g[ib + 1] += 2 * h * (2 * v1);
        g[ic] += 2 * h * (2 * u2);        g[ic + 1] += 2 * h * (2 * v2);
        g[id] += 2 * h * (-2 * u2);       g[id + 1] += 2 * h * (-2 * v2);
      });
      break;
    }

    case 'parallel': {
      const l1 = lineById.get(entityIds[0]), l2 = lineById.get(entityIds[1]);
      if (!l1 || !l2) return;
      const ia = pIdx.get(l1.p1Id), ib = pIdx.get(l1.p2Id);
      const ic = pIdx.get(l2.p1Id), id = pIdx.get(l2.p2Id);
      if (ia === undefined || ib === undefined || ic === undefined || id === undefined) return;
      eFns.push((x) => {
        const dx1 = x[ib] - x[ia], dy1 = x[ib + 1] - x[ia + 1];
        const dx2 = x[id] - x[ic], dy2 = x[id + 1] - x[ic + 1];
        const cross = dx1 * dy2 - dy1 * dx2;
        return cross * cross;
      });
      gFns.push((x, g) => {
        const dx1 = x[ib] - x[ia], dy1 = x[ib + 1] - x[ia + 1];
        const dx2 = x[id] - x[ic], dy2 = x[id + 1] - x[ic + 1];
        const cross = dx1 * dy2 - dy1 * dx2;
        const t = 2 * cross;
        g[ia] += t * (-dy2);       g[ia + 1] += t * (dx2);
        g[ib] += t * (dy2);        g[ib + 1] += t * (-dx2);
        g[ic] += t * (dy1);        g[ic + 1] += t * (-dx1);
        g[id] += t * (-dy1);       g[id + 1] += t * (dx1);
      });
      break;
    }

    case 'perpendicular': {
      const l1 = lineById.get(entityIds[0]), l2 = lineById.get(entityIds[1]);
      if (!l1 || !l2) return;
      const ia = pIdx.get(l1.p1Id), ib = pIdx.get(l1.p2Id);
      const ic = pIdx.get(l2.p1Id), id = pIdx.get(l2.p2Id);
      if (ia === undefined || ib === undefined || ic === undefined || id === undefined) return;
      eFns.push((x) => {
        const dx1 = x[ib] - x[ia], dy1 = x[ib + 1] - x[ia + 1];
        const dx2 = x[id] - x[ic], dy2 = x[id + 1] - x[ic + 1];
        const d = dx1 * dx2 + dy1 * dy2;
        return d * d;
      });
      gFns.push((x, g) => {
        const dx1 = x[ib] - x[ia], dy1 = x[ib + 1] - x[ia + 1];
        const dx2 = x[id] - x[ic], dy2 = x[id + 1] - x[ic + 1];
        const d = dx1 * dx2 + dy1 * dy2;
        const t = 2 * d;
        g[ia] += t * (-dx2);       g[ia + 1] += t * (-dy2);
        g[ib] += t * (dx2);        g[ib + 1] += t * (dy2);
        g[ic] += t * (-dx1);       g[ic + 1] += t * (-dy1);
        g[id] += t * (dx1);        g[id + 1] += t * (dy1);
      });
      break;
    }

    case 'tangent': {
      const lineEnt = lineById.get(entityIds[0]) ? entityIds[0] : entityIds[1];
      const circEnt = circleById.get(entityIds[0]) ? entityIds[0] :
                      circleById.get(entityIds[1]) ? entityIds[1] :
                      arcById.get(entityIds[0]) ? entityIds[0] : entityIds[1];
      const line = lineById.get(lineEnt);
      const circle = circleById.get(circEnt);
      const arc = arcById.get(circEnt);
      if (!line || (!circle && !arc)) return;

      const ia = pIdx.get(line.p1Id), ib = pIdx.get(line.p2Id);
      let centerId: string, radius: number;
      if (circle) {
        centerId = circle.centerId;
        radius = circle.radius;
      } else {
        const a = arc!;
        centerId = a.centerId;
        const cp = pointById.get(centerId)!, sp = pointById.get(a.startId)!;
        radius = Math.sqrt((sp.x - cp.x) ** 2 + (sp.y - cp.y) ** 2);
      }
      const ic = pIdx.get(centerId);
      if (ia === undefined || ib === undefined || ic === undefined) return;

      eFns.push((x) => {
        const ux = x[ib] - x[ia], uy = x[ib + 1] - x[ia + 1];
        const a = ux * (x[ia + 1] - x[ic + 1]) - uy * (x[ia] - x[ic]);
        const b = ux * ux + uy * uy;
        const h = a * a - b * radius * radius;
        return h * h;
      });
      gFns.push((x, g) => {
        const ux = x[ib] - x[ia], uy = x[ib + 1] - x[ia + 1];
        const cx = x[ic], cy = x[ic + 1];
        const a = ux * (x[ia + 1] - cy) - uy * (x[ia] - cx);
        const b = ux * ux + uy * uy;
        const h = a * a - b * radius * radius;
        const r = radius;

        const dax0 = -(x[ib + 1] - cy);
        const day0 = x[ib] - cx;
        const dax1 = x[ia + 1] - cy;
        const day1 = -(x[ia] - cx);
        const dacx = uy;
        const dacy = -ux;

        const dbx0 = -2 * ux;
        const dby0 = -2 * uy;
        const dbx1 = 2 * ux;
        const dby1 = 2 * uy;

        const t = 2 * h;
        g[ia] += t * (2 * a * dax0 - r * r * dbx0);
        g[ia + 1] += t * (2 * a * day0 - r * r * dby0);
        g[ib] += t * (2 * a * dax1 - r * r * dbx1);
        g[ib + 1] += t * (2 * a * day1 - r * r * dby1);
        g[ic] += t * (2 * a * dacx);
        g[ic + 1] += t * (2 * a * dacy);
      });
      break;
    }

    case 'concentric': {
      let cid0: string | undefined, cid1: string | undefined;
      const c0 = circleById.get(entityIds[0]);
      const a0 = arcById.get(entityIds[0]);
      const c1 = circleById.get(entityIds[1]);
      const a1 = arcById.get(entityIds[1]);
      cid0 = c0?.centerId ?? a0?.centerId;
      cid1 = c1?.centerId ?? a1?.centerId;
      if (!cid0 || !cid1) return;
      const i0 = pIdx.get(cid0), i1 = pIdx.get(cid1);
      if (i0 === undefined || i1 === undefined) return;
      eFns.push((x) => {
        const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1];
        return dx * dx + dy * dy;
      });
      gFns.push((x, g) => {
        const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1];
        g[i0] += -2 * dx; g[i0 + 1] += -2 * dy;
        g[i1] += 2 * dx;  g[i1 + 1] += 2 * dy;
      });
      break;
    }

    case 'midpoint': {
      const line = lineById.get(entityIds[0]);
      const pid = entityIds[1];
      if (!line) return;
      const i0 = pIdx.get(line.p1Id), i1 = pIdx.get(line.p2Id);
      const ip = pIdx.get(pid);
      if (i0 === undefined || i1 === undefined || ip === undefined) return;
      eFns.push((x) => {
        const mx = (x[i0] + x[i1]) / 2, my = (x[i0 + 1] + x[i1 + 1]) / 2;
        const dx = x[ip] - mx, dy = x[ip + 1] - my;
        return dx * dx + dy * dy;
      });
      gFns.push((x, g) => {
        const mx = (x[i0] + x[i1]) / 2, my = (x[i0 + 1] + x[i1 + 1]) / 2;
        const dx = x[ip] - mx, dy = x[ip + 1] - my;
        g[ip] += 2 * dx;       g[ip + 1] += 2 * dy;
        g[i0] += -dx;          g[i0 + 1] += -dy;
        g[i1] += -dx;          g[i1 + 1] += -dy;
      });
      break;
    }

    case 'pointOnLine': {
      const line = lineById.get(entityIds[0]);
      const pid = entityIds[1];
      if (!line) return;
      const i0 = pIdx.get(line.p1Id), i1 = pIdx.get(line.p2Id);
      const ip = pIdx.get(pid);
      if (i0 === undefined || i1 === undefined || ip === undefined) return;
      eFns.push((x) => {
        const h = (x[i1 + 1] - x[i0 + 1]) * (x[i0] - x[ip])
                - (x[i1] - x[i0]) * (x[i0 + 1] - x[ip + 1]);
        return h * h;
      });
      gFns.push((x, g) => {
        const x0 = x[i0], y0 = x[i0 + 1], x1 = x[i1], y1 = x[i1 + 1];
        const px = x[ip], py = x[ip + 1];
        const h = (y1 - y0) * (x0 - px) - (x1 - x0) * (y0 - py);
        const t = 2 * h;
        g[i0] += t * (y1 - py);       g[i0 + 1] += t * (px - x1);
        g[i1] += t * (py - y0);       g[i1 + 1] += t * (x0 - px);
        g[ip] += t * (y0 - y1);       g[ip + 1] += t * (x1 - x0);
      });
      break;
    }

    case 'distance': {
      const p0 = pointById.get(entityIds[0]);
      const p1 = pointById.get(entityIds[1]);
      const line = lineById.get(entityIds[0]);
      let i0: number | undefined, i1: number | undefined;

      if (p0 && p1) {
        i0 = pIdx.get(p0.id);
        i1 = pIdx.get(p1.id);
      } else if (line) {
        i0 = pIdx.get(line.p1Id);
        i1 = pIdx.get(line.p2Id);
      }
      if (i0 === undefined || i1 === undefined) return;
      const dist = params?.distance ?? 0;
      eFns.push((x) => {
        const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1];
        const h = dx * dx + dy * dy - dist * dist;
        return h * h;
      });
      gFns.push((x, g) => {
        const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1];
        const h = dx * dx + dy * dy - dist * dist;
        g[i0] += 2 * h * (-2 * dx);   g[i0 + 1] += 2 * h * (-2 * dy);
        g[i1] += 2 * h * (2 * dx);    g[i1 + 1] += 2 * h * (2 * dy);
      });
      break;
    }

    case 'length': {
      const line = lineById.get(entityIds[0]);
      if (!line) return;
      const i0 = pIdx.get(line.p1Id), i1 = pIdx.get(line.p2Id);
      if (i0 === undefined || i1 === undefined) return;
      const dist = params?.distance ?? 0;
      eFns.push((x) => {
        const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1];
        const h = dx * dx + dy * dy - dist * dist;
        return h * h;
      });
      gFns.push((x, g) => {
        const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1];
        const h = dx * dx + dy * dy - dist * dist;
        g[i0] += 2 * h * (-2 * dx);   g[i0 + 1] += 2 * h * (-2 * dy);
        g[i1] += 2 * h * (2 * dx);    g[i1 + 1] += 2 * h * (2 * dy);
      });
      break;
    }

    case 'horizontalDistance': {
      const i0 = pIdx.get(entityIds[0]), i1 = pIdx.get(entityIds[1]);
      if (i0 === undefined || i1 === undefined) return;
      const dist = params?.distance ?? 0;
      eFns.push((x) => {
        const h = (x[i1] - x[i0]) * (x[i1] - x[i0]) - dist * dist;
        return h * h;
      });
      gFns.push((x, g) => {
        const dx = x[i1] - x[i0];
        const h = dx * dx - dist * dist;
        g[i0] += 2 * h * (-2 * dx);
        g[i1] += 2 * h * (2 * dx);
      });
      break;
    }

    case 'verticalDistance': {
      const i0 = pIdx.get(entityIds[0]), i1 = pIdx.get(entityIds[1]);
      if (i0 === undefined || i1 === undefined) return;
      const dist = params?.distance ?? 0;
      eFns.push((x) => {
        const h = (x[i1 + 1] - x[i0 + 1]) * (x[i1 + 1] - x[i0 + 1]) - dist * dist;
        return h * h;
      });
      gFns.push((x, g) => {
        const dy = x[i1 + 1] - x[i0 + 1];
        const h = dy * dy - dist * dist;
        g[i0 + 1] += 2 * h * (-2 * dy);
        g[i1 + 1] += 2 * h * (2 * dy);
      });
      break;
    }

    case 'radius': {
      const arc = arcById.get(entityIds[0]);
      if (!arc) return;
      const ic = pIdx.get(arc.centerId), is = pIdx.get(arc.startId);
      if (ic === undefined || is === undefined) return;
      const r = params?.radius ?? 0;
      eFns.push((x) => {
        const dx = x[is] - x[ic], dy = x[is + 1] - x[ic + 1];
        const h = dx * dx + dy * dy - r * r;
        return h * h;
      });
      gFns.push((x, g) => {
        const dx = x[is] - x[ic], dy = x[is + 1] - x[ic + 1];
        const h = dx * dx + dy * dy - r * r;
        g[ic] += 2 * h * (-2 * dx);   g[ic + 1] += 2 * h * (-2 * dy);
        g[is] += 2 * h * (2 * dx);    g[is + 1] += 2 * h * (2 * dy);
      });
      break;
    }

    case 'angle': {
      const l1 = lineById.get(entityIds[0]), l2 = lineById.get(entityIds[1]);
      if (!l1 || !l2) return;
      const ia = pIdx.get(l1.p1Id), ib = pIdx.get(l1.p2Id);
      const ic = pIdx.get(l2.p1Id), id = pIdx.get(l2.p2Id);
      if (ia === undefined || ib === undefined || ic === undefined || id === undefined) return;
      const target = (params?.angle ?? 90) * Math.PI / 180;
      const cosT = Math.cos(target), sinT = Math.sin(target);
      eFns.push((x) => {
        const dx1 = x[ib] - x[ia], dy1 = x[ib + 1] - x[ia + 1];
        const dx2 = x[id] - x[ic], dy2 = x[id + 1] - x[ic + 1];
        const cross = dx1 * dy2 - dy1 * dx2;
        const dot = dx1 * dx2 + dy1 * dy2;
        const h = cross * cosT - dot * sinT;
        return h * h;
      });
      gFns.push((x, g) => {
        const dx1 = x[ib] - x[ia], dy1 = x[ib + 1] - x[ia + 1];
        const dx2 = x[id] - x[ic], dy2 = x[id + 1] - x[ic + 1];
        const cross = dx1 * dy2 - dy1 * dx2;
        const dot = dx1 * dx2 + dy1 * dy2;
        const h = cross * cosT - dot * sinT;
        const t = 2 * h;
        g[ia]     += t * (-dy2 * cosT + dx2 * sinT);
        g[ia + 1] += t * ( dx2 * cosT + dy2 * sinT);
        g[ib]     += t * ( dy2 * cosT - dx2 * sinT);
        g[ib + 1] += t * (-dx2 * cosT - dy2 * sinT);
        g[ic]     += t * ( dy1 * cosT + dx1 * sinT);
        g[ic + 1] += t * (-dx1 * cosT + dy1 * sinT);
        g[id]     += t * (-dy1 * cosT - dx1 * sinT);
        g[id + 1] += t * ( dx1 * cosT - dy1 * sinT);
      });
      break;
    }

    case 'symmetry': {
      const axisLine = lineById.get(entityIds[0]);
      if (!axisLine) return;
      const ix0 = pIdx.get(axisLine.p1Id);
      const ix1 = pIdx.get(axisLine.p2Id);
      if (ix0 === undefined || ix1 === undefined) return;

      const idA = entityIds[1];
      const idB = entityIds[2];

      const pushSymmetricPointPair = (iA: number, iB: number) => {
        // Use axis-length–normalized residuals. Raw cross/dot products scale with |v|²; reference
        // axes (e.g. x-axis endpoints at ±10000) made h1,h2 ~20000× geometric error, energy ~10⁸×
        // too large, ill-conditioning L-BFGS and breaking DoF probing (false "fully constrained").
        // E = (h1²+h2²)/|v|² is the sum of squared perpendicular distance to the line and squared
        // chord component along the unit axis (reflection conditions in consistent units).
        eFns.push((x) => {
          const x0 = x[ix0], y0 = x[ix0 + 1], x1 = x[ix1], y1 = x[ix1 + 1];
          const xa = x[iA], ya = x[iA + 1], xb = x[iB], yb = x[iB + 1];
          const vx = x1 - x0, vy = y1 - y0;
          const L2 = vx * vx + vy * vy;
          if (L2 < 1e-24) return 0;
          const Mx = (xa + xb) / 2, My = (ya + yb) / 2;
          const h1 = (Mx - x0) * vy - (My - y0) * vx;
          const h2 = (xb - xa) * vx + (yb - ya) * vy;
          return (h1 * h1 + h2 * h2) / L2;
        });
        gFns.push((x, g) => {
          const x0 = x[ix0], y0 = x[ix0 + 1], x1 = x[ix1], y1 = x[ix1 + 1];
          const xa = x[iA], ya = x[iA + 1], xb = x[iB], yb = x[iB + 1];
          const vx = x1 - x0, vy = y1 - y0;
          const L2 = vx * vx + vy * vy;
          if (L2 < 1e-24) return;
          const invL2 = 1 / L2;
          const FoverL4 = 1 / (L2 * L2);
          const Mx = (xa + xb) / 2, My = (ya + yb) / 2;
          const h1 = (Mx - x0) * vy - (My - y0) * vx;
          const h2 = (xb - xa) * vx + (yb - ya) * vy;
          const F = h1 * h1 + h2 * h2;
          const t1 = 2 * h1, t2 = 2 * h2;
          // ∂(F/L2)/∂q = (1/L2)∂F/∂q − (F/L2²)∂(L2)/∂q
          g[iA] += invL2 * (t1 * (0.5 * vy) + t2 * (-vx));
          g[iA + 1] += invL2 * (t1 * (-0.5 * vx) + t2 * (-vy));
          g[iB] += invL2 * (t1 * (0.5 * vy) + t2 * vx);
          g[iB + 1] += invL2 * (t1 * (-0.5 * vx) + t2 * vy);
          const gix0 = t1 * (-vy + (My - y0)) + t2 * (-(xb - xa));
          const giy0 = t1 * (-(Mx - x0) + vx) + t2 * (-(yb - ya));
          const gix1 = t1 * (-(My - y0)) + t2 * (xb - xa);
          const giy1 = t1 * (Mx - x0) + t2 * (yb - ya);
          g[ix0] += invL2 * gix0 + FoverL4 * F * (2 * vx);
          g[ix0 + 1] += invL2 * giy0 + FoverL4 * F * (2 * vy);
          g[ix1] += invL2 * gix1 - FoverL4 * F * (2 * vx);
          g[ix1 + 1] += invL2 * giy1 - FoverL4 * F * (2 * vy);
        });
      };

      if (pointById.has(idA) && pointById.has(idB)) {
        const iA = pIdx.get(idA);
        const iB = pIdx.get(idB);
        if (iA !== undefined && iB !== undefined) pushSymmetricPointPair(iA, iB);
        break;
      }

      const lineA = lineById.get(idA);
      const lineB = lineById.get(idB);
      if (lineA && lineB) {
        // B's stored p1/p2 order may not correspond to A's (e.g. opposite edge winding).
        // applyConstraint sets swapLineBEndpoints when (A1↔B2)+(A2↔B1) is the low-residual pairing.
        const swapB = (params?.swapLineBEndpoints ?? 0) !== 0;
        const bP1 = swapB ? lineB.p2Id : lineB.p1Id;
        const bP2 = swapB ? lineB.p1Id : lineB.p2Id;
        const a1 = pIdx.get(lineA.p1Id), a2 = pIdx.get(lineA.p2Id);
        const b1 = pIdx.get(bP1), b2 = pIdx.get(bP2);
        if (a1 !== undefined && a2 !== undefined && b1 !== undefined && b2 !== undefined) {
          pushSymmetricPointPair(a1, b1);
          pushSymmetricPointPair(a2, b2);
        }
        break;
      }

      const circA = circleById.get(idA);
      const circB = circleById.get(idB);
      if (circA && circB) {
        const iA = pIdx.get(circA.centerId);
        const iB = pIdx.get(circB.centerId);
        if (iA !== undefined && iB !== undefined) pushSymmetricPointPair(iA, iB);
        break;
      }

      const arcA = arcById.get(idA);
      const arcB = arcById.get(idB);
      if (arcA && arcB) {
        const cA = pIdx.get(arcA.centerId), sA = pIdx.get(arcA.startId), eA = pIdx.get(arcA.endId);
        const cB = pIdx.get(arcB.centerId), sB = pIdx.get(arcB.startId), eB = pIdx.get(arcB.endId);
        if (cA !== undefined && sA !== undefined && eA !== undefined && cB !== undefined && sB !== undefined && eB !== undefined) {
          pushSymmetricPointPair(cA, cB);
          pushSymmetricPointPair(sA, sB);
          pushSymmetricPointPair(eA, eB);
        }
        break;
      }
      break;
    }

    case 'arcRadius': {
      const arc = arcById.get(entityIds[0]);
      if (!arc) return;
      const ic = pIdx.get(arc.centerId), is = pIdx.get(arc.startId), ie = pIdx.get(arc.endId);
      if (ic === undefined || is === undefined || ie === undefined) return;
      eFns.push((x) => {
        const dsx = x[is] - x[ic], dsy = x[is + 1] - x[ic + 1];
        const dex = x[ie] - x[ic], dey = x[ie + 1] - x[ic + 1];
        const ds2 = dsx * dsx + dsy * dsy;
        const de2 = dex * dex + dey * dey;
        const h = de2 - ds2;
        return h * h;
      });
      gFns.push((x, g) => {
        const dsx = x[is] - x[ic], dsy = x[is + 1] - x[ic + 1];
        const dex = x[ie] - x[ic], dey = x[ie + 1] - x[ic + 1];
        const h = (dex * dex + dey * dey) - (dsx * dsx + dsy * dsy);
        const t = 2 * h;
        g[ic] += t * (2 * (dsx - dex));       g[ic + 1] += t * (2 * (dsy - dey));
        g[is] += t * (-2 * dsx);              g[is + 1] += t * (-2 * dsy);
        g[ie] += t * (2 * dex);               g[ie + 1] += t * (2 * dey);
      });
      break;
    }
  }
}

// Scale factor applied to constraint energy/gradient when a drag target is present.
// This makes constraints ~10,000× stiffer than drag force so points stay precisely on
// the constraint manifold during interactive drags.
const DRAG_CONSTRAINT_SCALE = 1e4;

export function solveConstraints(
  points: SolverPoint[],
  lines: SolverLine[],
  circles: SolverCircle[],
  arcs: SolverArc[],
  constraints: SolverConstraint[],
  dragTarget?: DragTarget,
  maxLBFGSIter?: number,
  /** Override constraint scale (default: DRAG_CONSTRAINT_SCALE when drag present, 1 otherwise). */
  constraintScale?: number
): SolveResult {
  if (constraints.length === 0 || points.length === 0) {
    return { success: true, points, iterations: 0, energy: 0, constraintEnergy: 0, dragEnergy: 0 };
  }

  const pointById = new Map(points.map(p => [p.id, p]));
  const lineById = new Map(lines.map(l => [l.id, l]));
  const circleById = new Map(circles.map(c => [c.id, c]));
  const arcById = new Map(arcs.map(a => [a.id, a]));

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
      if (pointById.has(eid)) {
        refPointIds.add(eid);
      } else if (lineById.has(eid)) {
        const line = lineById.get(eid)!;
        refPointIds.add(line.p1Id);
        refPointIds.add(line.p2Id);
      } else if (circleById.has(eid)) {
        refPointIds.add(circleById.get(eid)!.centerId);
      } else if (arcById.has(eid)) {
        const arc = arcById.get(eid)!;
        refPointIds.add(arc.centerId);
        refPointIds.add(arc.startId);
        refPointIds.add(arc.endId);
      }
    }
  }

  if (dragTarget && pointById.has(dragTarget.pointId)) {
    refPointIds.add(dragTarget.pointId);
  }

  const pIds = [...refPointIds];
  const pIdx = new Map<string, number>();
  const vars: number[] = [];

  for (const pid of pIds) {
    const p = pointById.get(pid);
    if (!p) continue;
    pIdx.set(pid, vars.length);
    vars.push(p.x, p.y);
  }

  if (vars.length === 0) {
    return { success: true, points, iterations: 0, energy: 0, constraintEnergy: 0, dragEnergy: 0 };
  }

  const eFns: EFn[] = [];
  const gFns: GFn[] = [];

  const fixedPointIds = new Set<string>();
  for (const c of constraints) {
    if (c.type === "fix" && c.entityIds[0]) fixedPointIds.add(c.entityIds[0]);
  }
  for (const vpid of [REF_ORIGIN_ID, REF_XA_P1, REF_XA_P2, REF_YA_P1, REF_YA_P2]) {
    if (pIdx.has(vpid)) fixedPointIds.add(vpid);
  }

  const effectiveConstraints: SolverConstraint[] = [...constraints];
  for (const vpid of [REF_ORIGIN_ID, REF_XA_P1, REF_XA_P2, REF_YA_P1, REF_YA_P2]) {
    if (pIdx.has(vpid)) {
      const vp = pointById.get(vpid)!;
      effectiveConstraints.push({
        id: `fix_${vpid}`,
        type: "fix",
        entityIds: [vpid],
        params: { x: vp.x, y: vp.y },
      });
    }
  }

  for (const c of effectiveConstraints) {
    registerConstraint(c, pointById, lineById, circleById, arcById, pIdx, eFns, gFns);
  }

  if (eFns.length === 0 && !dragTarget) {
    return { success: true, points, iterations: 0, energy: 0, constraintEnergy: 0, dragEnergy: 0 };
  }
  if (eFns.length === 0 && dragTarget) {
    const idx = pIdx.get(dragTarget.pointId);
    if (idx === undefined || fixedPointIds.has(dragTarget.pointId)) {
      return { success: true, points, iterations: 0, energy: 0, constraintEnergy: 0, dragEnergy: 0 };
    }
    const newPoints = points.map(p =>
      p.id === dragTarget.pointId ? { ...p, x: dragTarget.x, y: dragTarget.y } : p
    );
    return { success: true, points: newPoints, iterations: 1, energy: 0, constraintEnergy: 0, dragEnergy: 0 };
  }

  const CSCALE = constraintScale ?? (dragTarget ? DRAG_CONSTRAINT_SCALE : 1);

  const rawConstraintEnergy = (x: number[]): number => {
    let e = 0;
    for (const fn of eFns) e += fn(x);
    return e;
  };
  const dragOnlyEnergy = (x: number[]): number => {
    if (!dragTarget || fixedPointIds.has(dragTarget.pointId)) return 0;
    const idx = pIdx.get(dragTarget.pointId);
    if (idx === undefined) return 0;
    const w = dragTarget.strength ?? 0.1;
    const dx = x[idx] - dragTarget.x;
    const dy = x[idx + 1] - dragTarget.y;
    return w * (dx * dx + dy * dy);
  };
  const totalEnergy = (x: number[]): number => CSCALE * rawConstraintEnergy(x) + dragOnlyEnergy(x);
  const totalGradInto = (x: number[], out: number[]): void => {
    for (let i = 0; i < out.length; i++) out[i] = 0;
    for (const fn of gFns) fn(x, out);
    if (CSCALE !== 1) {
      for (let i = 0; i < out.length; i++) out[i] *= CSCALE;
    }
    if (dragTarget && !fixedPointIds.has(dragTarget.pointId)) {
      const idx = pIdx.get(dragTarget.pointId);
      if (idx !== undefined) {
        const w = dragTarget.strength ?? 0.1;
        out[idx] += 2 * w * (x[idx] - dragTarget.x);
        out[idx + 1] += 2 * w * (x[idx + 1] - dragTarget.y);
      }
    }
  };

  const lbfgsIter = maxLBFGSIter ?? (dragTarget ? 120 : 200);
  // Energy tolerance: we want rawConstraintEnergy < 1e-8, which in scaled space is CSCALE * 1e-8.
  const energyTol = CSCALE * 1e-8;
  const result = lbfgsSolve(vars, totalEnergy, totalGradInto, lbfgsIter, 1e-10, energyTol);

  const newPoints = points.map(p => {
    const idx = pIdx.get(p.id);
    if (idx !== undefined) {
      return { ...p, x: result.x[idx], y: result.x[idx + 1] };
    }
    return p;
  });

  const cEnergy = rawConstraintEnergy(result.x);
  const dEnergy = dragOnlyEnergy(result.x);
  return {
    success: cEnergy < 1e-4,
    points: newPoints,
    iterations: result.iterations,
    energy: cEnergy + dEnergy,
    constraintEnergy: cEnergy,
    dragEnergy: dEnergy,
  };
}
