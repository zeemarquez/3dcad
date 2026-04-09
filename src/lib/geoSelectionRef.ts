import type { GeometricSelectionRef } from '../store/useCadStore';

export function isPlaneRef(
  ref: GeometricSelectionRef | null,
): ref is Extract<GeometricSelectionRef, { type: 'defaultPlane' | 'face' | 'plane' }> {
  return !!ref && (ref.type === 'defaultPlane' || ref.type === 'face' || ref.type === 'plane');
}

export function isPointRef(
  ref: GeometricSelectionRef | null,
): ref is Extract<GeometricSelectionRef, { type: 'point' }> {
  return !!ref && ref.type === 'point';
}

export function isEdgeRef(
  ref: GeometricSelectionRef | null,
): ref is Extract<GeometricSelectionRef, { type: 'edge' }> {
  return !!ref && ref.type === 'edge';
}

export function isRevolveAxisRef(
  ref: GeometricSelectionRef | null,
): ref is Extract<GeometricSelectionRef, { type: 'worldAxis' | 'edge' | 'axisFeature' }> {
  return !!ref && (ref.type === 'worldAxis' || ref.type === 'edge' || ref.type === 'axisFeature');
}
