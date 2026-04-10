import type { AxisFeature, Feature, PointFeature } from '../store/useCadStore';
import {
  normalize3,
  cross3,
  dot3,
  planeEquationFromRef,
  worldPositionFromAxisTwoPointSlot,
} from '@/core/sketchPlaneBasis';

function sub3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(a: [number, number, number], s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function add3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/**
 * Infinite line (point + unit direction) for a construction axis feature, in world space.
 */
export function getAxisLineFromAxisFeature(af: AxisFeature, features: Feature[]): {
  p: [number, number, number];
  d: [number, number, number];
} | null {
  const p = af.parameters;
  if (p.method === 'twoPoints') {
    const a = worldPositionFromAxisTwoPointSlot(p, 1, features);
    const b = worldPositionFromAxisTwoPointSlot(p, 2, features);
    if (!a || !b) return null;
    const dRaw = sub3(b, a);
    const d = normalize3(dRaw);
    if (Math.hypot(dRaw[0], dRaw[1], dRaw[2]) < 1e-12) return null;
    return { p: a, d };
  }
  if (p.method === 'planePoint') {
    const pl = p.planeRef ? planeEquationFromRef(p.planeRef, features) : null;
    if (!pl) return null;
    const d = normalize3(pl.n);
    const pref = p.pointRef;
    let origin: [number, number, number] | null = null;
    if (pref?.type === 'point' && Array.isArray(pref.position)) {
      origin = [pref.position[0], pref.position[1], pref.position[2]];
    } else if (p.pointId) {
      const pt = features.find((f): f is PointFeature => f.type === 'point' && f.id === p.pointId) as
        | PointFeature
        | undefined;
      if (pt) origin = [pt.parameters.x, pt.parameters.y, pt.parameters.z];
    }
    if (!origin) return null;
    return { p: origin, d };
  }
  if (p.method === 'twoPlanes') {
    const pa = p.planeRefA ? planeEquationFromRef(p.planeRefA, features) : null;
    const pb = p.planeRefB ? planeEquationFromRef(p.planeRefB, features) : null;
    if (!pa || !pb) return null;
    const dRaw = cross3(pa.n, pb.n);
    const lenSq = dot3(dRaw, dRaw);
    if (lenSq < 1e-20) return null;
    const d = normalize3(dRaw);
    const term1 = cross3(pb.n, dRaw);
    const term2 = cross3(dRaw, pa.n);
    const origin = scale3(add3(scale3(term1, pa.d), scale3(term2, pb.d)), 1 / lenSq);
    return { p: origin, d };
  }
  return null;
}

export function getAxisLineFromAxisFeatureId(
  axisFeatureId: string | null | undefined,
  features: Feature[],
): { p: [number, number, number]; d: [number, number, number] } | null {
  if (!axisFeatureId) return null;
  const af = features.find((f): f is AxisFeature => f.type === 'axis' && f.id === axisFeatureId);
  if (!af) return null;
  return getAxisLineFromAxisFeature(af, features);
}
