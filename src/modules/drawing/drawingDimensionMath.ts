import * as THREE from 'three';

/** ~1.15° — edge must read horizontal/vertical in the view plane. */
const STRAIGHT_SIN_TOL = 0.02;

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
