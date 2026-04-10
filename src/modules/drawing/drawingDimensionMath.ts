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
