import { useCadStore } from '../store/useCadStore';
import type {
  Feature,
  GeometricSelectionRef,
  PlaneFeature,
  PointFeature,
  SketchFeature,
} from '../store/useCadStore';

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

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function sketchBasisFromUnitNormalAndDistance(n: [number, number, number], d: number): SketchPlaneBasis {
  const nn = normalize3(n);
  const t = d;
  const origin: [number, number, number] = [nn[0] * t, nn[1] * t, nn[2] * t];
  const helper: [number, number, number] = Math.abs(nn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize3(cross3(helper, nn));
  const v = normalize3(cross3(nn, u));
  return { origin, u, v, n: nn };
}

function planeEquationFromRef(ref: GeometricSelectionRef | null, features: Feature[]): { n: [number, number, number]; d: number } | null {
  if (!ref) return null;
  if (ref.type === 'defaultPlane') {
    if (ref.name === 'xy') return { n: [0, 0, 1], d: 0 };
    if (ref.name === 'xz') return { n: [0, 1, 0], d: 0 };
    return { n: [1, 0, 0], d: 0 };
  }
  if (ref.type === 'face') {
    const len = Math.hypot(ref.normal[0], ref.normal[1], ref.normal[2]);
    if (len < 1e-12) return null;
    const n: [number, number, number] = [ref.normal[0] / len, ref.normal[1] / len, ref.normal[2] / len];
    return { n, d: ref.faceOffset };
  }
  if (ref.type === 'plane') {
    const feat = features.find((f) => f.id === ref.featureId);
    if (!feat || feat.type !== 'plane') return null;
    return planeEquationFromPlaneFeature(feat as PlaneFeature, features);
  }
  return null;
}

function planeEquationFromPlaneFeature(pf: PlaneFeature, features: Feature[]): { n: [number, number, number]; d: number } | null {
  const p = pf.parameters;
  if (p.method === 'offset') {
    const ref = p.reference;
    if (!ref) return null;
    const pl = planeEquationFromRef(ref, features);
    if (!pl) return null;
    const off = Number(p.offset) || 0;
    return { n: pl.n, d: pl.d + off };
  }
  if (p.method === 'threePoints') {
    const pointById = new Map(
      features.filter((f): f is PointFeature => f.type === 'point').map((f) => [f.id, f]),
    );
    const id1 = p.point1Id;
    const id2 = p.point2Id;
    const id3 = p.point3Id;
    if (!id1 || !id2 || !id3) return null;
    const t1 = pointById.get(id1);
    const t2 = pointById.get(id2);
    const t3 = pointById.get(id3);
    if (!t1 || !t2 || !t3) return null;
    const p1: [number, number, number] = [t1.parameters.x, t1.parameters.y, t1.parameters.z];
    const p2: [number, number, number] = [t2.parameters.x, t2.parameters.y, t2.parameters.z];
    const p3: [number, number, number] = [t3.parameters.x, t3.parameters.y, t3.parameters.z];
    const e1 = sub3(p2, p1);
    const e2 = sub3(p3, p1);
    const nc = cross3(e1, e2);
    const len = Math.hypot(nc[0], nc[1], nc[2]);
    if (len < 1e-12) return null;
    const n: [number, number, number] = [nc[0] / len, nc[1] / len, nc[2] / len];
    const d = dot3(n, p1);
    return { n, d };
  }
  return null;
}

function computePlaneFeatureSketchBasis(pf: PlaneFeature, features: Feature[]): SketchPlaneBasis | null {
  const eq = planeEquationFromPlaneFeature(pf, features);
  if (!eq) return null;
  return sketchBasisFromUnitNormalAndDistance(eq.n, eq.d);
}

function defaultBasis(plane: 'xy' | 'xz' | 'yz', off: number): SketchPlaneBasis {
  switch (plane) {
    case 'xz':
      // Must match replicad `Plane`: yDir = normal × xDir = [0,1,0]×[1,0,0] → −Z sketch Y.
      return {
        origin: [0, off, 0],
        u: [1, 0, 0],
        v: [0, 0, -1],
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
 * Full sketch plane basis: origin planes, face planes, and construction plane features (from planeRef).
 */
export function getSketchPlaneBasis(sk: SketchFeature): SketchPlaneBasis {
  const ref = sk.parameters.planeRef;
  const paramOff = Number(sk.parameters.planeOffset) || 0;

  if (ref?.type === 'plane') {
    const features = useCadStore.getState().features;
    const pf = features.find((f) => f.id === ref.featureId);
    if (pf?.type === 'plane') {
      const basis = computePlaneFeatureSketchBasis(pf as PlaneFeature, features);
      if (basis) {
        const n = basis.n;
        const o = basis.origin;
        return {
          ...basis,
          origin: [
            o[0] + n[0] * paramOff,
            o[1] + n[1] * paramOff,
            o[2] + n[2] * paramOff,
          ],
        };
      }
    }
    return defaultBasis(sk.parameters.plane, paramOff);
  }

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

/**
 * Orthographic projection of world point onto the sketch plane: drop component along plane normal, then take (u,v).
 * Equivalent to dot with u,v when (u,v,n) is orthonormal; more stable if inputs drift slightly.
 */
export function worldToSketch2D(sk: SketchFeature, px: number, py: number, pz: number): { x: number; y: number } {
  const { origin, u, v, n } = getSketchPlaneBasis(sk);
  let dx = px - origin[0];
  let dy = py - origin[1];
  let dz = pz - origin[2];
  const dn = dx * n[0] + dy * n[1] + dz * n[2];
  dx -= dn * n[0];
  dy -= dn * n[1];
  dz -= dn * n[2];
  return {
    x: dx * u[0] + dy * u[1] + dz * u[2],
    y: dx * v[0] + dy * v[1] + dz * v[2],
  };
}
