/**
 * Circular arc sampling for 2D sketch entities (center + start + end on the circle).
 * Default branch is the **shorter** arc between start and end (≤ π); optional
 * `complementaryArc` selects the **longer** branch (major arc between the two points).
 */

export type ArcSamplingOptions = {
  /** True = longer arc between start and end. False/omit = shorter (minor) arc. */
  complementaryArc?: boolean;
};

const RAY_EPS = 1e-9;

/**
 * True if the segment (x0,y0)-(x1,y1) crosses the open ray from the origin along +x
 * (the line y=0 with x>0). Used during arc placement so the minor/major branch toggles
 * when the cursor path crosses angle 0°, not when it crosses the ±π atan2 seam (angle 180°).
 */
export function segmentCrossesPositiveXAxis(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): boolean {
  if (Math.abs(y0) < RAY_EPS && Math.abs(y1) < RAY_EPS) return false;
  if (y0 * y1 > 0) return false;
  const dy = y1 - y0;
  if (Math.abs(dy) < RAY_EPS) return false;
  const t = -y0 / dy;
  if (t <= RAY_EPS || t >= 1 - RAY_EPS) return false;
  const xi = x0 + t * (x1 - x0);
  return xi > RAY_EPS;
}

/** Signed angular sweep in (-2π, 2π) from a0 to a1 for the chosen branch. */
export function arcSignedSweep(a0: number, a1: number, complementaryArc?: boolean): number {
  const shortest = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  if (!complementaryArc) return shortest;
  return shortest > 0 ? shortest - 2 * Math.PI : shortest + 2 * Math.PI;
}

export function sampleArcPoints(
  center: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
  maxSegAngle = Math.PI / 24,
  opts?: ArcSamplingOptions
): { x: number; y: number }[] {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  if (r < 1e-8) return [start, end];
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const sweep = arcSignedSweep(a0, a1, opts?.complementaryArc);
  const sweepAbs = Math.abs(sweep);
  if (sweepAbs < 1e-10) return [start, end];
  const segs = Math.max(2, Math.ceil(sweepAbs / maxSegAngle));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = a0 + sweep * t;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}
