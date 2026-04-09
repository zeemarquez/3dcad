/**
 * Open uniform B-spline (2D), clamped ends — common for sketch splines.
 * Degree p (default 3): needs at least p+1 control points.
 */

export const BSPLINE_DEFAULT_DEGREE = 3;

/** Default density for `sampleOpenUniformBSpline` (segments per knot span); higher = smoother polylines. */
export const BSPLINE_DEFAULT_SAMPLES_PER_SPAN = 24;

/** Slightly coarser sampling for hit-testing / box selection (performance). */
export const BSPLINE_HIT_SAMPLES_PER_SPAN = 16;

/** Open uniform knot vector for n+1 control points and degree p. */
export function openUniformKnots(numControlPoints: number, degree: number): number[] {
  const n = numControlPoints - 1;
  const p = degree;
  const m = n + p + 2;
  const U: number[] = new Array(m);
  for (let i = 0; i <= p; i++) U[i] = 0;
  for (let i = p + 1; i <= n; i++) U[i] = i - p;
  for (let i = n + 1; i <= n + p + 1; i++) U[i] = n - p + 1;
  return U;
}

function basis(
  i: number,
  p: number,
  u: number,
  U: number[],
  n: number
): number {
  if (p === 0) {
    const last = U.length - 1;
    if (Math.abs(u - U[last]) < 1e-14 && i === n) return 1;
    return u >= U[i] && u < U[i + 1] ? 1 : 0;
  }
  const d1 = U[i + p] - U[i];
  const d2 = U[i + p + 1] - U[i + 1];
  let a = 0;
  let b = 0;
  if (Math.abs(d1) > 1e-18) a = ((u - U[i]) / d1) * basis(i, p - 1, u, U, n);
  if (Math.abs(d2) > 1e-18) b = ((U[i + p + 1] - u) / d2) * basis(i + 1, p - 1, u, U, n);
  return a + b;
}

/** Evaluate one point on the open uniform B-spline at parameter u. */
export function evaluateBSpline2D(
  u: number,
  controlPoints: { x: number; y: number }[],
  degree: number,
  knots: number[]
): { x: number; y: number } {
  const n = controlPoints.length - 1;
  const p = degree;
  let x = 0;
  let y = 0;
  for (let i = 0; i <= n; i++) {
    const w = basis(i, p, u, knots, n);
    x += controlPoints[i].x * w;
    y += controlPoints[i].y * w;
  }
  return { x, y };
}

/** First derivative dC/du (finite difference; stable on clamped spline domain). */
export function evaluateBSplineDerivativeWrtU(
  u: number,
  controlPoints: { x: number; y: number }[],
  degree: number,
  knots: number[]
): { x: number; y: number } {
  const n = controlPoints.length - 1;
  const p = degree;
  const uMin = knots[p];
  const uMax = knots[n + 1];
  const span = uMax - uMin;
  const h = Math.max(1e-14, span * 1e-9);
  let u0 = u - h;
  let u1 = u + h;
  if (u0 < uMin) {
    u0 = uMin;
    u1 = Math.min(uMax, uMin + 2 * h);
  }
  if (u1 > uMax) {
    u1 = uMax;
    u0 = Math.max(uMin, uMax - 2 * h);
  }
  if (u1 <= u0 + 1e-18) return { x: 0, y: 0 };
  const p0 = evaluateBSpline2D(u0, controlPoints, degree, knots);
  const p2 = evaluateBSpline2D(u1, controlPoints, degree, knots);
  const inv = 1 / (u1 - u0);
  return { x: (p2.x - p0.x) * inv, y: (p2.y - p0.y) * inv };
}

export interface CubicBezierSegment2D {
  b0: { x: number; y: number };
  b1: { x: number; y: number };
  b2: { x: number; y: number };
  b3: { x: number; y: number };
}

/**
 * Exact piecewise cubic Bezier form of an open uniform degree-3 B-spline (B-rep friendly).
 */
export function uniformBsplineToCubicBezierSegments(
  controlPoints: { x: number; y: number }[],
  degree: number
): CubicBezierSegment2D[] {
  if (degree !== 3 || controlPoints.length < 4) return [];
  const knots = openUniformKnots(controlPoints.length, degree);
  const n = controlPoints.length - 1;
  const p = degree;
  const uMin = knots[p];
  const uMax = knots[n + 1];
  const distinct: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    if (i === 0 || Math.abs(knots[i] - knots[i - 1]!) > 1e-12) distinct.push(knots[i]!);
  }
  const out: CubicBezierSegment2D[] = [];
  for (let j = 0; j < distinct.length - 1; j++) {
    let ua = distinct[j]!;
    let ub = distinct[j + 1]!;
    if (ub <= ua + 1e-15) continue;
    ua = Math.max(ua, uMin);
    ub = Math.min(ub, uMax);
    if (ub <= ua + 1e-15) continue;
    const du = ub - ua;
    const eps = Math.max(1e-14, du * 1e-8);
    const uTan0 = ua + eps;
    const uTan1 = ub - eps;
    const P0 = evaluateBSpline2D(ua, controlPoints, degree, knots);
    const P3 = evaluateBSpline2D(ub, controlPoints, degree, knots);
    const T0 = evaluateBSplineDerivativeWrtU(uTan0, controlPoints, degree, knots);
    const T3 = evaluateBSplineDerivativeWrtU(uTan1, controlPoints, degree, knots);
    const B0 = P0;
    const B3 = P3;
    const B1 = { x: B0.x + (T0.x * du) / 3, y: B0.y + (T0.y * du) / 3 };
    const B2 = { x: B3.x - (T3.x * du) / 3, y: B3.y - (T3.y * du) / 3 };
    out.push({ b0: B0, b1: B1, b2: B2, b3: B3 });
  }
  return out;
}

/**
 * Sample the spline as a dense polyline for rendering / loop detection.
 * `samplesPerSpan` scales segment count: total steps ≈ numInteriorKnotSpans * samplesPerSpan.
 */
export function sampleOpenUniformBSpline(
  controlPoints: { x: number; y: number }[],
  degree: number,
  samplesPerSpan: number
): { x: number; y: number }[] {
  if (controlPoints.length < degree + 1) return [];
  const knots = openUniformKnots(controlPoints.length, degree);
  const n = controlPoints.length - 1;
  const p = degree;
  const uMin = knots[p];
  const uMax = knots[n + 1];
  let numSpans = 0;
  for (let i = 0; i < knots.length - 1; i++) {
    if (Math.abs(knots[i + 1] - knots[i]) > 1e-12) numSpans++;
  }
  const steps = Math.max(32, Math.ceil(numSpans * Math.max(4, samplesPerSpan)));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = uMin + (i / steps) * (uMax - uMin);
    out.push(evaluateBSpline2D(u, controlPoints, degree, knots));
  }
  const dedup: { x: number; y: number }[] = [];
  for (const q of out) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-10) dedup.push(q);
  }
  return dedup.length >= 2 ? dedup : [];
}
