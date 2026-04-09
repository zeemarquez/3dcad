import { useMemo } from 'react';
import { useCadStore } from '../store/useCadStore';
import type { Feature } from '../store/useCadStore';

/** Geometry kinds that can be filtered in part viewport selection mode */
export type PartViewportGeometryKind =
  | 'sketch'
  | 'face'
  | 'edge'
  | 'point'
  | 'defaultPlane'
  | 'plane'
  | 'worldAxis'
  | 'axisFeature';

export type PartViewportMode =
  | { type: 'normal' }
  | {
      type: 'featureEdit';
      /** Solid feature selected in the tree while its parameters are shown */
      editingFeatureId: string | null;
      /** New feature command with live preview (no tree selection) */
      creatingWithCommand: string | null;
    }
  | { type: 'selection'; field: string; allowed: PartViewportGeometryKind[] };

const PLANE_FACE_INPUT_FIELDS = new Set([
  'sketchPlane',
  'sketchPlaneEdit',
  'planeRef',
  'axisPlaneRef',
  'axisPlaneRefA',
  'axisPlaneRefB',
  'pointPlaneRef',
]);

const POINT_ONLY_INPUT_FIELDS = new Set([
  'planePoint1Ref',
  'planePoint2Ref',
  'planePoint3Ref',
  'pointBaseRef',
  /** Axis: plane + point — viewport picks construction points or solid vertices */
  'axisPointRef',
  'axisTwoPoints1Ref',
  'axisTwoPoints2Ref',
]);

/**
 * Allowed geometry kinds for the active PropertyManager geometric input field.
 * Keep in sync with SelectionInput / GeometricInput field keys.
 */
export function allowedGeometryKindsFromField(field: string): PartViewportGeometryKind[] {
  if (field === 'revolveAxis') return ['edge', 'worldAxis', 'axisFeature'];
  if (field.endsWith('Edges')) return ['edge'];
  if (field.startsWith('sketch_')) return ['sketch'];
  if (PLANE_FACE_INPUT_FIELDS.has(field)) return ['face', 'defaultPlane', 'plane'];
  if (POINT_ONLY_INPUT_FIELDS.has(field)) return ['point'];
  return ['sketch', 'face', 'edge', 'point', 'defaultPlane'];
}

export function isFeatureEditPreviewActive(params: {
  features: Feature[];
  selectedFeatureId: string | null;
  activeCommand: string | null;
  transientPreviewFeature: Feature | null;
}): boolean {
  const { features, selectedFeatureId, activeCommand, transientPreviewFeature } = params;
  const selectedIndex = selectedFeatureId ? features.findIndex((f) => f.id === selectedFeatureId) : -1;
  const selectedFeature = selectedIndex >= 0 ? features[selectedIndex] : null;
  const editableSolidFeature =
    !!selectedFeature &&
    ['extrude', 'cut', 'revolve', 'revolveCut', 'fillet', 'chamfer'].includes(selectedFeature.type);
  const canPreviewCreate =
    !selectedFeature &&
    !!activeCommand &&
    ['extrude', 'cut', 'revolve', 'revolveCut', 'fillet', 'chamfer'].includes(activeCommand) &&
    !!transientPreviewFeature;
  return (!!editableSolidFeature && !!selectedFeature) || (!!canPreviewCreate && !!transientPreviewFeature);
}

export function computePartViewportMode(params: {
  activeInputField: string | null;
  features: Feature[];
  selectedFeatureId: string | null;
  activeCommand: string | null;
  transientPreviewFeature: Feature | null;
}): PartViewportMode {
  if (params.activeInputField) {
    return {
      type: 'selection',
      field: params.activeInputField,
      allowed: allowedGeometryKindsFromField(params.activeInputField),
    };
  }
  if (
    !isFeatureEditPreviewActive({
      features: params.features,
      selectedFeatureId: params.selectedFeatureId,
      activeCommand: params.activeCommand,
      transientPreviewFeature: params.transientPreviewFeature,
    })
  ) {
    return { type: 'normal' };
  }
  const selectedIndex = params.selectedFeatureId
    ? params.features.findIndex((f) => f.id === params.selectedFeatureId)
    : -1;
  const selectedFeature = selectedIndex >= 0 ? params.features[selectedIndex] : null;
  const editingSolid =
    !!selectedFeature &&
    ['extrude', 'cut', 'revolve', 'revolveCut', 'fillet', 'chamfer'].includes(selectedFeature.type);
  const creatingNew =
    !selectedFeature &&
    !!params.activeCommand &&
    ['extrude', 'cut', 'revolve', 'revolveCut', 'fillet', 'chamfer'].includes(params.activeCommand) &&
    !!params.transientPreviewFeature;
  return {
    type: 'featureEdit',
    editingFeatureId: editingSolid && selectedFeature ? selectedFeature.id : null,
    creatingWithCommand: creatingNew ? params.activeCommand : null,
  };
}

export function usePartViewportMode(): PartViewportMode {
  const activeInputField = useCadStore((s) => s.activeInputField);
  const features = useCadStore((s) => s.features);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const activeCommand = useCadStore((s) => s.activeCommand);
  const transientPreviewFeature = useCadStore((s) => s.transientPreviewFeature);
  return useMemo(
    () =>
      computePartViewportMode({
        activeInputField,
        features,
        selectedFeatureId,
        activeCommand,
        transientPreviewFeature,
      }),
    [activeInputField, features, selectedFeatureId, activeCommand, transientPreviewFeature],
  );
}
