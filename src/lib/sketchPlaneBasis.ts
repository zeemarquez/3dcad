import type { SketchFeature } from '../store/useCadStore';

export function normalize3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-12) return [1, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export interface SketchPlaneBasis {
  /** Origin of sketch 2D (0,0) in world space */
  origin: [number, number, number];
  /** Sketch +X */
  u: [number, number, number];
  /** Sketch +Y */
  v: [number, number, number];
  /** Plane normal (extrusion / outward) */
  n: [number, number, number];
}

function defaultBasis(plane: 'xy' | 'xz' | 'yz', off: number): SketchPlaneBasis {
  switch (plane) {
    case 'xz':
      return {
        origin: [0, off, 0],
        u: [1, 0, 0],
        v: [0, 0, 1],
        n: [0, 1, 0],
      };
    case 'yz':
      return {
        origin: [off, 0, 0],
        u: [0, 1, 0],
        v: [0, 0, 1],
        n: [1, 0, 0],
      };
    default:
      return {
        origin: [0, 0, off],
        u: [1, 0, 0],
        v: [0, 1, 0],
        n: [0, 0, 1],
      };
  }
}

/**
 * Full sketch plane basis: supports origin planes and arbitrary face planes (from planeRef).
 */
export function getSketchPlaneBasis(sk: SketchFeature): SketchPlaneBasis {
  const ref = sk.parameters.planeRef;
  const paramOff = Number(sk.parameters.planeOffset) || 0;

  if (ref?.type === 'face') {
    const [nx, ny, nz] = ref.normal;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) {
      return defaultBasis(sk.parameters.plane, paramOff);
    }
    const n = normalize3([nx, ny, nz]);
    // n·p = d with unit n; origin on plane closest to world origin is d*n.
    // `faceOffset` is d. `parameters.planeOffset` must not be added: it duplicates
    // the same distance when geoRefToPlaneAndOffset also wrote an axis-aligned offset.
    const t = ref.faceOffset;
    const origin: [number, number, number] = [n[0] * t, n[1] * t, n[2] * t];
    const helper: [number, number, number] = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize3(cross3(helper, n));
    const v = normalize3(cross3(n, u));
    return { origin, u, v, n };
  }

  if (ref?.type === 'defaultPlane') {
    return defaultBasis(ref.name, paramOff);
  }

  return defaultBasis(sk.parameters.plane, paramOff);
}

export function sketch2DToWorld(sk: SketchFeature, x: number, y: number): [number, number, number] {
  const { origin, u, v } = getSketchPlaneBasis(sk);
  return [
    origin[0] + u[0] * x + v[0] * y,
    origin[1] + u[1] * x + v[1] * y,
    origin[2] + u[2] * x + v[2] * y,
  ];
}

export function worldToSketch2D(sk: SketchFeature, px: number, py: number, pz: number): { x: number; y: number } {
  const { origin, u, v } = getSketchPlaneBasis(sk);
  const dx = px - origin[0];
  const dy = py - origin[1];
  const dz = pz - origin[2];
  return {
    x: dx * u[0] + dy * u[1] + dz * u[2],
    y: dx * v[0] + dy * v[1] + dz * v[2],
  };
}
