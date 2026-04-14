import * as THREE from 'three';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';

/** ~1.15° — edge must read horizontal/vertical in the view plane. */
const STRAIGHT_SIN_TOL = 0.02;

const CLOSED_LOOP_TOL = 1.5e-2;
const MIN_CIRCLE_SAMPLES = 8;
/** Relative radius deviation for tessellation to count as a circle (planar loop). */
const CIRCLE_RADIAL_FIT_REL_TOL = 0.035;
const CIRCLE_RADIAL_FIT_ABS_TOL_MM = 0.12;

export function modelVertexKey(x: number, y: number, z: number, prec = 5): string {
  return `${x.toFixed(prec)},${y.toFixed(prec)},${z.toFixed(prec)}`;
}

/** Ordered polyline from one edge-group chunk of `edgeVertices` (segment pairs, with duplicate joints). */
export function polylineFromEdgeGroupChunk(chunk: Float32Array): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i + 5 < chunk.length; i += 6) {
    const a = new THREE.Vector3(chunk[i], chunk[i + 1], chunk[i + 2]);
    const b = new THREE.Vector3(chunk[i + 3], chunk[i + 4], chunk[i + 5]);
    if (pts.length === 0) {
      pts.push(a, b);
    } else {
      const last = pts[pts.length - 1];
      if (last.distanceTo(a) < 1e-4) pts.push(b);
      else pts.push(a, b);
    }
  }
  return pts;
}

function isClosedPlanarCircleLike(pts: THREE.Vector3[]): THREE.Vector3 | null {
  if (pts.length < MIN_CIRCLE_SAMPLES) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.distanceTo(last) > CLOSED_LOOP_TOL) return null;

  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);

  let rSum = 0;
  for (const p of pts) rSum += p.distanceTo(c);
  const rMean = rSum / pts.length;
  if (rMean < 1e-4) return null;

  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, Math.abs(p.distanceTo(c) - rMean));
  const tol = Math.max(CIRCLE_RADIAL_FIT_ABS_TOL_MM, CIRCLE_RADIAL_FIT_REL_TOL * rMean);
  if (maxDev > tol) return null;

  return c;
}

export type SolidCirclePickInfo = {
  /** Circle center in solid local coordinates (same frame as `edgeVertices`). */
  centerModel: THREE.Vector3;
  /** Tessellated rim in local coordinates (for screen-space hover). */
  rimModel: THREE.Vector3[];
};

export type SolidDimensionPickMeta = {
  circles: SolidCirclePickInfo[];
  /**
   * Model-space keys for circle rim points that are **only** part of circular edge tessellation.
   * Vertices shared with lines / other topology stay out of this set so they remain pickable.
   */
  rimOnlyExcludeModelKeys: Set<string>;
};

function addSegmentEndpointKeysFromChunk(chunk: Float32Array, into: Set<string>) {
  for (let i = 0; i + 5 < chunk.length; i += 6) {
    for (const j of [0, 3] as const) {
      const x = chunk[i + j];
      const y = chunk[i + j + 1];
      const z = chunk[i + j + 2];
      into.add(modelVertexKey(x, y, z));
    }
  }
}

/**
 * Classify circular edge groups vs other edges, and compute which rim tessellation vertices can
 * be hidden (rim-only) without removing real part corners.
 */
export function extractSolidDimensionPickMeta(s: SolidMeshData): SolidDimensionPickMeta {
  const ev = s.edgeVertices;
  const starts = s.edgeGroupStarts;
  if (!ev || ev.length < 6) {
    return { circles: [], rimOnlyExcludeModelKeys: new Set() };
  }

  const totalPoints = ev.length / 3;
  const groups =
    starts.length > 0
      ? starts.map((start, i) => ({
          start,
          end: i + 1 < starts.length ? starts[i + 1] : totalPoints,
        }))
      : [{ start: 0, end: totalPoints }];

  const nonCircleEndpointKeys = new Set<string>();
  const circles: SolidCirclePickInfo[] = [];
  const allCircleRimKeys = new Set<string>();

  for (const g of groups) {
    const chunk = ev.subarray(g.start * 3, g.end * 3);
    if (chunk.length < 6) continue;

    const pts = polylineFromEdgeGroupChunk(chunk);
    const center = isClosedPlanarCircleLike(pts);
    if (center) {
      for (const p of pts) allCircleRimKeys.add(modelVertexKey(p.x, p.y, p.z));
      // Same keys as non-circle groups use raw `chunk` floats — avoids rim-only false positives when
      // polyline reconstruction differs slightly from segment endpoints.
      addSegmentEndpointKeysFromChunk(chunk, allCircleRimKeys);
      const rimModel = pts.slice(0, -1).map((p) => p.clone());
      circles.push({ centerModel: center, rimModel });
    } else {
      addSegmentEndpointKeysFromChunk(chunk, nonCircleEndpointKeys);
    }
  }

  const rimOnlyExcludeModelKeys = new Set<string>();
  for (const k of allCircleRimKeys) {
    if (!nonCircleEndpointKeys.has(k)) rimOnlyExcludeModelKeys.add(k);
  }

  return { circles, rimOnlyExcludeModelKeys };
}

/**
 * When the cursor is near the rim (2D) or inside the circle, return the world-space center for hover/pick.
 */
export function pickCircleCenterAtScreen(
  circles: { center: THREE.Vector3; rim: THREE.Vector3[] }[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
  rimPxTol: number,
): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestScore = Infinity;

  const proj = (p: THREE.Vector3) => {
    const t = p.clone().project(camera);
    return { px: (t.x * 0.5 + 0.5) * w, py: (-t.y * 0.5 + 0.5) * h };
  };

  for (const circ of circles) {
    const { px: cpx, py: cpy } = proj(circ.center);
    if (!circ.rim.length) continue;

    let rMean = 0;
    let minRimD = Infinity;
    for (const p of circ.rim) {
      const { px, py } = proj(p);
      const dr = Math.hypot(px - cpx, py - cpy);
      rMean += dr;
      minRimD = Math.min(minRimD, Math.hypot(cx - px, cy - py));
    }
    rMean /= circ.rim.length;

    const dC = Math.hypot(cx - cpx, cy - cpy);
    const nearRim = minRimD <= rimPxTol;
    const inside = rMean > 2 && dC <= rMean * 1.02;

    if (!nearRim && !inside) continue;

    const score = Math.min(dC, minRimD);
    if (score < bestScore) {
      bestScore = score;
      best = circ.center;
    }
  }
  return best;
}

export function isHorizontalInView(a: THREE.Vector3, b: THREE.Vector3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  return Math.abs(dy) / len < STRAIGHT_SIN_TOL;
}

export function isVerticalInView(a: THREE.Vector3, b: THREE.Vector3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  return Math.abs(dx) / len < STRAIGHT_SIN_TOL;
}

export function projectedSpanMm(kind: 'horizontal' | 'vertical', a: THREE.Vector3, b: THREE.Vector3): number {
  return kind === 'horizontal' ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
}

/** Both segments read as horizontal or both as vertical in the view plane (parallel families). */
export function areParallelStraightInView(
  a1: THREE.Vector3,
  b1: THREE.Vector3,
  a2: THREE.Vector3,
  b2: THREE.Vector3,
): boolean {
  const h1 = isHorizontalInView(a1, b1);
  const h2 = isHorizontalInView(a2, b2);
  const v1 = isVerticalInView(a1, b1);
  const v2 = isVerticalInView(a2, b2);
  return (h1 && h2) || (v1 && v2);
}

/** Horizontal linear dimension between two parallel vertical edges (measure horizontal separation). */
export function endpointsHorizontalDimBetweenVerticalEdges(
  a1: THREE.Vector3,
  b1: THREE.Vector3,
  a2: THREE.Vector3,
  b2: THREE.Vector3,
): { a: THREE.Vector3; b: THREE.Vector3 } {
  const m1x = (a1.x + b1.x) / 2;
  const m1y = (a1.y + b1.y) / 2;
  const m2x = (a2.x + b2.x) / 2;
  const m2y = (a2.y + b2.y) / 2;
  const z = (a1.z + b1.z + a2.z + b2.z) / 4;
  return {
    a: new THREE.Vector3(m1x, m1y, z),
    b: new THREE.Vector3(m2x, m2y, z),
  };
}

/** Vertical linear dimension between two parallel horizontal edges (measure vertical separation). */
export function endpointsVerticalDimBetweenHorizontalEdges(
  a1: THREE.Vector3,
  b1: THREE.Vector3,
  a2: THREE.Vector3,
  b2: THREE.Vector3,
): { a: THREE.Vector3; b: THREE.Vector3 } {
  const m1x = (a1.x + b1.x) / 2;
  const m1y = (a1.y + b1.y) / 2;
  const m2x = (a2.x + b2.x) / 2;
  const m2y = (a2.y + b2.y) / 2;
  const z = (a1.z + b1.z + a2.z + b2.z) / 4;
  return {
    a: new THREE.Vector3(m1x, m1y, z),
    b: new THREE.Vector3(m2x, m2y, z),
  };
}

export function validHorizontalDimParallelEdgePair(
  a1: THREE.Vector3,
  b1: THREE.Vector3,
  a2: THREE.Vector3,
  b2: THREE.Vector3,
): boolean {
  return isVerticalInView(a1, b1) && isVerticalInView(a2, b2);
}

export function validVerticalDimParallelEdgePair(
  a1: THREE.Vector3,
  b1: THREE.Vector3,
  a2: THREE.Vector3,
  b2: THREE.Vector3,
): boolean {
  return isHorizontalInView(a1, b1) && isHorizontalInView(a2, b2);
}
