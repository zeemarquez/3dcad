import { create } from 'zustand';
import {
  applyRadiusValueToSketchGeometry,
  resolveSketchDataAfterDimensionValueChange,
  type SketchConstraint,
  type SketchDataSnapshot,
  useSketchStore,
} from './useSketchStore';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type FeatureType =
  | 'sketch'
  | 'extrude'
  | 'plane'
  | 'point'
  | 'axis'
  | 'cut'
  | 'revolve'
  | 'revolveCut'
  | 'fillet'
  | 'chamfer';

export type GeometricSelectionRef =
  | { type: 'defaultPlane'; name: 'xy' | 'xz' | 'yz'; label: string }
  /** User-defined construction plane feature */
  | { type: 'plane'; featureId: string; featureName: string; label: string }
  | { type: 'face'; featureId: string; featureName: string; normal: [number, number, number]; faceOffset: number; label: string }
  | { type: 'point'; featureId: string; featureName: string; position: [number, number, number]; label: string }
  | { type: 'sketch'; featureId: string; featureName: string; label: string }
  /** World X / Y / Z axis through the sketch origin (parallel to global axes) */
  | { type: 'worldAxis'; axis: 'x' | 'y' | 'z'; label: string }
  /** Construction axis feature (infinite line) */
  | { type: 'axisFeature'; featureId: string; featureName: string; label: string }
  | {
      type: 'edge';
      featureId: string;
      featureName: string;
      direction: [number, number, number];
      midpoint: [number, number, number];
      bbox?: { min: [number, number, number]; max: [number, number, number] };
      label: string;
    };

/** One of the references allowed for revolve / revolve cut axis */
export type RevolveAxisSelection = Extract<
  GeometricSelectionRef,
  { type: 'worldAxis' | 'edge' | 'axisFeature' }
>;

/** Options when starting viewport geometric picking (see activateGeometricInput). */
export interface GeometricInputOptions {
  /** Refs to show as already selected in the viewport */
  preselected?: GeometricSelectionRef[];
  /**
   * When editing a solid feature, pick against the model built from features *before* that feature.
   * Ensures edge/face IDs match stored refs (e.g. fillet/chamfer target body).
   */
  pickFromBeforeFeature?: boolean;
  /** Show B-rep mesh vertices (e.g. axis plane+point) with hover/click like edges */
  allowSolidVertices?: boolean;
}

export interface SketchData {
  points: { id: string; x: number; y: number }[];
  lines: { id: string; p1Id: string; p2Id: string; auxiliary?: boolean }[];
  circles: { id: string; centerId: string; radius: number; auxiliary?: boolean }[];
  arcs: {
    id: string;
    centerId: string;
    startId: string;
    endId: string;
    complementaryArc?: boolean;
    auxiliary?: boolean;
  }[];
  /** Open uniform B-spline through control polygon (degree 3 by default). */
  bsplines?: {
    id: string;
    controlPointIds: string[];
    degree?: number;
    auxiliary?: boolean;
  }[];
  constraints: { id: string; type: string; entityIds: string[]; params?: Record<string, number>; expression?: string }[];
}

export interface BaseFeature {
  id: string;
  name: string;
  type: FeatureType;
  enabled?: boolean;
}

export interface SketchFeature extends BaseFeature {
  type: 'sketch';
  parameters: {
    plane: 'xy' | 'xz' | 'yz';
    planeOffset: number;
    planeRef?: Extract<GeometricSelectionRef, { type: 'defaultPlane' | 'face' | 'plane' }> | null;
    sketchData?: SketchData;
  };
}

export interface ExtrudeFeature extends BaseFeature {
  type: 'extrude';
  parameters: {
    sketchId: string;
    height: number;
    reverse: boolean;
    symmetric: boolean;
    startOffset: number;
  };
}

export interface PlaneFeature extends BaseFeature {
  type: 'plane';
  parameters: {
    method: 'offset' | 'threePoints';
    reference: GeometricSelectionRef | null;
    offset: number;
    point1Id?: string | null;
    point2Id?: string | null;
    point3Id?: string | null;
    point1Ref?: Extract<GeometricSelectionRef, { type: 'point' }> | null;
    point2Ref?: Extract<GeometricSelectionRef, { type: 'point' }> | null;
    point3Ref?: Extract<GeometricSelectionRef, { type: 'point' }> | null;
  };
}

export interface PointFeature extends BaseFeature {
  type: 'point';
  parameters: {
    x: number;
    y: number;
    z: number;
    method?: 'coordinates' | 'offsetPoint' | 'planeAxisIntersection' | 'twoAxesIntersection';
    basePointId?: string | null;
    /** Base is a body vertex (solid feature id + world position), not a point feature */
    basePointRef?: Extract<GeometricSelectionRef, { type: 'point' }> | null;
    dx?: number;
    dy?: number;
    dz?: number;
    planeRef?: GeometricSelectionRef | null;
    axisFeatureId?: string | null;
    edgeRef?: Extract<GeometricSelectionRef, { type: 'edge' }> | null;
    axisFeatureIdA?: string | null;
    axisFeatureIdB?: string | null;
    edgeRefA?: Extract<GeometricSelectionRef, { type: 'edge' }> | null;
    edgeRefB?: Extract<GeometricSelectionRef, { type: 'edge' }> | null;
  };
}

export interface CutFeature extends BaseFeature {
  type: 'cut';
  parameters: {
    sketchId: string;
    depth: number;
    reverse: boolean;
    symmetric: boolean;
    startOffset: number;
  };
}

export interface AxisFeature extends BaseFeature {
  type: 'axis';
  parameters: {
    method: 'twoPoints' | 'planePoint' | 'twoPlanes';
    point1Id: string | null;
    point2Id: string | null;
    point1Ref?: Extract<GeometricSelectionRef, { type: 'point' }> | null;
    point2Ref?: Extract<GeometricSelectionRef, { type: 'point' }> | null;
    pointId: string | null;
    /** Full point ref when the point is a body vertex (featureId = solid); use position from ref */
    pointRef?: Extract<GeometricSelectionRef, { type: 'point' }> | null;
    planeRef: GeometricSelectionRef | null;
    planeRefA: GeometricSelectionRef | null;
    planeRefB: GeometricSelectionRef | null;
  };
}

export interface RevolveFeature extends BaseFeature {
  type: 'revolve';
  parameters: {
    sketchId: string;
    angle: number;
    /** @deprecated Prefer `revolveAxis`; kept for older sketches. */
    axis?: 'x' | 'y' | 'z';
    /** Offset along sketch plane normal (mm), same convention as extrude. */
    startOffset?: number;
    /** World axis, edge line, or construction axis. */
    revolveAxis?: RevolveAxisSelection | null;
  };
}

export interface RevolveCutFeature extends BaseFeature {
  type: 'revolveCut';
  parameters: {
    sketchId: string;
    angle: number;
    axis?: 'x' | 'y' | 'z';
    startOffset?: number;
    revolveAxis?: RevolveAxisSelection | null;
  };
}

export interface FilletFeature extends BaseFeature {
  type: 'fillet';
  parameters: {
    targetFeatureId: string;
    radius: number;
    edges: Extract<GeometricSelectionRef, { type: 'edge' }>[];
  };
}

export interface ChamferFeature extends BaseFeature {
  type: 'chamfer';
  parameters: {
    targetFeatureId: string;
    distance: number;
    edges: Extract<GeometricSelectionRef, { type: 'edge' }>[];
  };
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | PlaneFeature
  | PointFeature
  | AxisFeature
  | CutFeature
  | RevolveFeature
  | RevolveCutFeature
  | FilletFeature
  | ChamferFeature;

export interface MeshData {
  id: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export interface SolidResultItem {
  geometryId: string;
  featureId: string;
  featureName: string;
}

export interface Commit {
  id: string;
  message: string;
  timestamp: number;
  features: Feature[];
}

export interface UserParameter {
  id: string;
  name: string;
  expression: string;
  notes: string;
  resultValue: number;
}

export interface DimensionParameter {
  id: string;
  key: string;
  name: string;
  expression: string;
  notes: string;
  resultValue: number;
  parentFeatureId: string;
  parentFeatureName: string;
  dimensionType: 'HDISTANCE' | 'VDISTANCE' | 'LENGTH' | 'RADIUS' | 'ANGLE' | 'DISTANCE';
  target:
    | { kind: 'feature'; featureId: string; param: string }
    | { kind: 'sketchConstraint'; featureId: string; constraintId: string; paramKey: string };
}

export interface PartDocumentMeta {
  id: string;
  name: string;
  extension: '.par';
  createdAt: number;
  updatedAt: number;
}

export interface PartDocumentData {
  kind: 'part';
  version: 1;
  meta: PartDocumentMeta;
  parameters: {
    userParameters: UserParameter[];
    dimensionParameters: DimensionParameter[];
  };
  operations: Feature[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Store interface
// ──────────────────────────────────────────────────────────────────────────────

interface CadState {
  features: Feature[];
  meshes: MeshData[];
  solidResults: SolidResultItem[];
  setSolidResults: (items: SolidResultItem[]) => void;
  hiddenGeometryIds: string[];
  toggleGeometryVisibility: (id: string) => void;
  isGeometryVisible: (id: string) => boolean;
  addFeature: (feature: Feature) => void;
  updateFeatureParameter: (id: string, param: string, value: any) => void;
  evaluateFeatures: () => void;
  deleteFeature: (id: string) => void;
  renameFeature: (id: string, name: string) => void;
  toggleFeatureEnabled: (id: string) => void;

  activeModule: 'part' | 'sketch';
  setActiveModule: (module: 'part' | 'sketch') => void;
  activeCommand: string | null;
  setActiveCommand: (command: string | null) => void;
  selectedFeatureId: string | null;
  setSelectedFeatureId: (id: string | null) => void;
  selectedPlane: string | null;
  setSelectedPlane: (id: string | null) => void;

  /** Last face/plane clicked in normal (non-input) mode — used to pre-fill sketch plane */
  lastGeometricSelection: GeometricSelectionRef | null;
  setLastGeometricSelection: (ref: GeometricSelectionRef | null) => void;
  /** Incrementing token to broadcast "clear current face/edge selection" */
  selectionResetToken: number;
  triggerSelectionReset: () => void;

  activeSketchId: string | null;
  enterSketchMode: (sketchId: string) => void;
  exitSketchMode: () => void;

  /** Pre-selected sketch/reference when a command is activated */
  commandPreselection: string | null;
  setCommandPreselection: (id: string | null) => void;

  /** Geometric selection system for input boxes in PropertyManager */
  activeInputField: string | null;
  activeInputOptions: GeometricInputOptions | null;
  activateGeometricInput: (
    fieldName: string,
    callback: (sel: GeometricSelectionRef) => void,
    options?: GeometricInputOptions,
  ) => void;
  captureGeometricSelection: (sel: GeometricSelectionRef, keepActive?: boolean) => void;
  deactivateGeometricInput: () => void;
  transientPreviewFeature: Feature | null;
  setTransientPreviewFeature: (feature: Feature | null) => void;

  /** View settings */
  showGrid: boolean;
  toggleGrid: () => void;
  showOriginPlanes: boolean;
  toggleOriginPlanes: () => void;
  perspective: boolean;
  togglePerspective: () => void;
  pendingCameraView: string | null;
  setCameraView: (view: string) => void;
  clearPendingCameraView: () => void;

  commits: Commit[];
  commitChanges: (message: string) => void;
  checkoutCommit: (commitId: string) => void;

  isParametersDialogOpen: boolean;
  openParametersDialog: () => void;
  closeParametersDialog: () => void;
  userParameters: UserParameter[];
  dimensionParameters: DimensionParameter[];
  addUserParameter: () => { success: boolean; message: string };
  updateUserParameter: (id: string, patch: Partial<Pick<UserParameter, 'name' | 'expression' | 'notes'>>) => { success: boolean; message: string };
  updateDimensionParameter: (id: string, patch: Partial<Pick<DimensionParameter, 'expression' | 'notes'>>) => { success: boolean; message: string };
  linkDimensionExpression: (target: DimensionParameter['target'], expression: string) => { success: boolean; message: string };
  exportPartDocumentData: (meta: PartDocumentMeta) => PartDocumentData;
  importPartDocumentData: (doc: PartDocumentData) => void;
  resetDocument: () => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Initial data
// ──────────────────────────────────────────────────────────────────────────────

const initialFeatures: Feature[] = [
  {
    id: 'f1',
    name: 'Sketch 1',
    type: 'sketch',
    enabled: true,
    parameters: {
      plane: 'xy',
      planeOffset: 0,
      planeRef: { type: 'defaultPlane', name: 'xy', label: 'XY Plane' },
    },
  },
];

function cloneInitialFeatures(): Feature[] {
  return JSON.parse(JSON.stringify(initialFeatures)) as Feature[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Worker (kept for future OCCT precision operations)
// ──────────────────────────────────────────────────────────────────────────────

const cadWorker = new Worker(new URL('../kernel/cadWorker.ts', import.meta.url), { type: 'module' });

let _geoSelectionCb: ((sel: GeometricSelectionRef) => void) | null = null;
let _previewFeatureSig: string | null = null;

function parseNumericExpression(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function evaluateExpression(
  expression: string,
  env: Record<string, number>,
  selfName?: string
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (!trimmed) return { ok: false, message: 'Expression is empty' };
  if (!trimmed.startsWith('=')) {
    const n = parseNumericExpression(trimmed);
    if (n === null) return { ok: false, message: 'Invalid numeric value' };
    return { ok: true, value: n };
  }
  const body = trimmed.slice(1).trim();
  if (!body) return { ok: false, message: 'Expression is empty' };
  if (selfName) {
    const selfRef = new RegExp(`\\b${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (selfRef.test(body)) return { ok: false, message: 'Self reference is not allowed' };
  }
  let unknownToken: string | null = null;
  const replaced = body.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (token) => {
    if (Object.prototype.hasOwnProperty.call(env, token)) return String(env[token]);
    unknownToken = token;
    return token;
  });
  if (unknownToken) return { ok: false, message: `Unknown parameter: ${unknownToken}` };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${replaced});`);
    const result = Number(fn());
    if (!Number.isFinite(result)) return { ok: false, message: 'Expression result is not finite' };
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Invalid expression' };
  }
}

function getDimensionPrefix(type: string): DimensionParameter['dimensionType'] {
  if (type === 'horizontalDistance') return 'HDISTANCE';
  if (type === 'verticalDistance') return 'VDISTANCE';
  if (type === 'radius') return 'RADIUS';
  if (type === 'angle') return 'ANGLE';
  if (type === 'distance') return 'DISTANCE';
  return 'LENGTH';
}

function getFeatureDimensionTargets(feature: Feature): Array<{ key: string; value: number; dimensionType: DimensionParameter['dimensionType']; target: DimensionParameter['target'] }> {
  switch (feature.type) {
    case 'extrude':
      return [
        {
          key: `${feature.id}:height`,
          value: feature.parameters.height,
          dimensionType: 'LENGTH',
          target: { kind: 'feature', featureId: feature.id, param: 'height' },
        },
        {
          key: `${feature.id}:startOffset`,
          value: feature.parameters.startOffset,
          dimensionType: 'LENGTH',
          target: { kind: 'feature', featureId: feature.id, param: 'startOffset' },
        },
      ];
    case 'cut':
      return [
        {
          key: `${feature.id}:depth`,
          value: feature.parameters.depth,
          dimensionType: 'LENGTH',
          target: { kind: 'feature', featureId: feature.id, param: 'depth' },
        },
        {
          key: `${feature.id}:startOffset`,
          value: feature.parameters.startOffset,
          dimensionType: 'LENGTH',
          target: { kind: 'feature', featureId: feature.id, param: 'startOffset' },
        },
      ];
    case 'plane':
      return [
        {
          key: `${feature.id}:offset`,
          value: feature.parameters.offset,
          dimensionType: 'LENGTH',
          target: { kind: 'feature', featureId: feature.id, param: 'offset' },
        },
      ];
    case 'revolve':
    case 'revolveCut':
      return [
        {
          key: `${feature.id}:angle`,
          value: feature.parameters.angle,
          dimensionType: 'ANGLE',
          target: { kind: 'feature', featureId: feature.id, param: 'angle' },
        },
        {
          key: `${feature.id}:startOffset`,
          value: feature.parameters.startOffset ?? 0,
          dimensionType: 'LENGTH',
          target: { kind: 'feature', featureId: feature.id, param: 'startOffset' },
        },
      ];
    case 'fillet':
      return [
        {
          key: `${feature.id}:radius`,
          value: feature.parameters.radius,
          dimensionType: 'LENGTH',
          target: { kind: 'feature', featureId: feature.id, param: 'radius' },
        },
      ];
    case 'chamfer':
      return [
        {
          key: `${feature.id}:distance`,
          value: feature.parameters.distance,
          dimensionType: 'LENGTH',
          target: { kind: 'feature', featureId: feature.id, param: 'distance' },
        },
      ];
    case 'sketch': {
      const constraints = feature.parameters.sketchData?.constraints ?? [];
      return constraints
        .filter((c) => ['distance', 'length', 'horizontalDistance', 'verticalDistance', 'radius', 'angle'].includes(c.type))
        .map((c) => {
          const paramKey = c.type === 'radius' ? 'radius' : c.type === 'angle' ? 'angle' : 'distance';
          const value = Number(c.params?.[paramKey] ?? 0);
          const expression = typeof c.expression === 'string' && c.expression.trim().startsWith('=')
            ? c.expression.trim()
            : String(value);
          return {
            key: `${feature.id}:${c.id}:${paramKey}`,
            value,
            expression,
            dimensionType: getDimensionPrefix(c.type),
            target: { kind: 'sketchConstraint', featureId: feature.id, constraintId: c.id, paramKey },
          };
        });
    }
    default:
      return [];
  }
}

function targetEquals(a: DimensionParameter['target'], b: DimensionParameter['target']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'feature' && b.kind === 'feature') {
    return a.featureId === b.featureId && a.param === b.param;
  }
  if (a.kind === 'sketchConstraint' && b.kind === 'sketchConstraint') {
    return a.featureId === b.featureId && a.constraintId === b.constraintId && a.paramKey === b.paramKey;
  }
  return false;
}

function isSolidFeatureType(type: FeatureType): boolean {
  return (
    type === 'extrude' ||
    type === 'cut' ||
    type === 'revolve' ||
    type === 'revolveCut' ||
    type === 'fillet' ||
    type === 'chamfer'
  );
}

function getFeatureDependencyIds(feature: Feature): string[] {
  if (feature.type === 'extrude' || feature.type === 'cut') {
    return feature.parameters.sketchId ? [feature.parameters.sketchId] : [];
  }
  if (feature.type === 'revolve' || feature.type === 'revolveCut') {
    const deps: string[] = [];
    const p = feature.parameters;
    if (p.sketchId) deps.push(p.sketchId);
    const ra = p.revolveAxis;
    if (ra?.type === 'edge' && ra.featureId) deps.push(ra.featureId);
    if (ra?.type === 'axisFeature' && ra.featureId) deps.push(ra.featureId);
    return deps;
  }
  if (feature.type === 'fillet' || feature.type === 'chamfer') {
    const deps = new Set<string>();
    if (feature.parameters.targetFeatureId) deps.add(feature.parameters.targetFeatureId);
    for (const e of feature.parameters.edges ?? []) {
      if (e.featureId) deps.add(e.featureId);
    }
    return [...deps];
  }
  if (feature.type === 'plane' && feature.parameters.method === 'threePoints') {
    const p = feature.parameters;
    const deps: string[] = [];
    for (const slot of [1, 2, 3] as const) {
      const id = slot === 1 ? p.point1Id : slot === 2 ? p.point2Id : p.point3Id;
      const ref = slot === 1 ? p.point1Ref : slot === 2 ? p.point2Ref : p.point3Ref;
      if (id) deps.push(id);
      else if (ref?.type === 'point' && ref.featureId) deps.push(ref.featureId);
    }
    return deps;
  }
  if (feature.type === 'axis') {
    const deps: string[] = [];
    if (feature.parameters.method === 'twoPoints') {
      const ap = feature.parameters;
      if (ap.point1Id) deps.push(ap.point1Id);
      else if (ap.point1Ref?.type === 'point' && ap.point1Ref.featureId) deps.push(ap.point1Ref.featureId);
      if (ap.point2Id) deps.push(ap.point2Id);
      else if (ap.point2Ref?.type === 'point' && ap.point2Ref.featureId) deps.push(ap.point2Ref.featureId);
    } else if (feature.parameters.method === 'planePoint') {
      const pr = feature.parameters.pointRef;
      if (feature.parameters.pointId) deps.push(feature.parameters.pointId);
      else if (pr?.type === 'point' && pr.featureId) deps.push(pr.featureId);
    }
    return deps;
  }
  if (feature.type === 'point') {
    const deps: string[] = [];
    const p = feature.parameters;
    if (p.method === 'offsetPoint') {
      if (p.basePointId) deps.push(p.basePointId);
      else if (p.basePointRef?.type === 'point' && p.basePointRef.featureId) deps.push(p.basePointRef.featureId);
    }
    if (p.method === 'planeAxisIntersection' && p.axisFeatureId) deps.push(p.axisFeatureId);
    if (p.method === 'twoAxesIntersection') {
      if (p.axisFeatureIdA) deps.push(p.axisFeatureIdA);
      if (p.axisFeatureIdB) deps.push(p.axisFeatureIdB);
    }
    return deps;
  }
  return [];
}

function collectDependentFeatureIds(features: Feature[], rootId: string): Set<string> {
  const directDependentsById = new Map<string, string[]>();
  for (const f of features) {
    for (const depId of getFeatureDependencyIds(f)) {
      if (!directDependentsById.has(depId)) directDependentsById.set(depId, []);
      directDependentsById.get(depId)!.push(f.id);
    }
  }
  const out = new Set<string>();
  const queue: string[] = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    const dependents = directDependentsById.get(current) ?? [];
    for (const dep of dependents) {
      if (out.has(dep)) continue;
      out.add(dep);
      queue.push(dep);
    }
  }
  return out;
}

function buildDimensionParameters(features: Feature[], previous: DimensionParameter[]): DimensionParameter[] {
  const prevByKey = new Map(previous.map((p) => [p.key, p]));
  const nextIndexByType: Record<DimensionParameter['dimensionType'], number> = {
    HDISTANCE: 0,
    VDISTANCE: 0,
    LENGTH: 0,
    RADIUS: 0,
    ANGLE: 0,
    DISTANCE: 0,
  };

  // Keep previously assigned names stable forever.
  // New dimensions get the next index after the highest historical index.
  for (const p of previous) {
    const m = p.name.match(/^([A-Z]+)_(\d+)$/);
    if (!m) continue;
    const rawType = m[1] as DimensionParameter['dimensionType'];
    const idx = Number(m[2]);
    if (!(rawType in nextIndexByType) || !Number.isFinite(idx)) continue;
    if (idx > nextIndexByType[rawType]) nextIndexByType[rawType] = idx;
  }

  const out: DimensionParameter[] = [];
  for (const feature of features) {
    const targets = getFeatureDimensionTargets(feature);
    for (const t of targets) {
      const prev = prevByKey.get(t.key);
      if (!prev) {
        nextIndexByType[t.dimensionType] += 1;
      }
      const featureExpr = (t as { expression?: string }).expression;
      out.push({
        id: prev?.id ?? `dim_${t.key}`,
        key: t.key,
        name: prev?.name ?? `${t.dimensionType}_${nextIndexByType[t.dimensionType]}`,
        expression: prev?.expression ?? featureExpr ?? String(t.value),
        notes: prev?.notes ?? '',
        resultValue: prev?.resultValue ?? t.value,
        parentFeatureId: feature.id,
        parentFeatureName: feature.name,
        dimensionType: t.dimensionType,
        target: t.target,
      });
    }
  }
  return out;
}

function applyValueToDimensionTarget(features: Feature[], dim: DimensionParameter, value: number): Feature[] {
  return features.map((f) => {
    if (f.id !== dim.parentFeatureId) return f;
    const target = dim.target;
    if (target.kind === 'feature') {
      return {
        ...f,
        parameters: { ...f.parameters, [target.param]: value },
      } as Feature;
    }
    if (target.kind !== 'sketchConstraint') return f;
    if (f.type !== 'sketch') return f;
    const sketchData = f.parameters.sketchData;
    if (!sketchData) return f;
    const updatedConstraints = sketchData.constraints.map((c) =>
      c.id === target.constraintId
        ? { ...c, params: { ...(c.params ?? {}), [target.paramKey]: value } }
        : c
    ) as SketchConstraint[];
    let nextSketchData: SketchData = { ...sketchData, constraints: updatedConstraints };
    if (target.paramKey === 'radius') {
      const cn = sketchData.constraints.find((c) => c.id === target.constraintId);
      const entityId = cn?.entityIds?.[0];
      if (entityId) {
        const g = applyRadiusValueToSketchGeometry(
          sketchData.points,
          sketchData.circles,
          sketchData.arcs,
          updatedConstraints,
          entityId,
          value
        );
        nextSketchData = { ...nextSketchData, points: g.points, circles: g.circles };
      }
    }
    nextSketchData = resolveSketchDataAfterDimensionValueChange(nextSketchData as SketchDataSnapshot) as SketchData;
    return {
      ...f,
      parameters: {
        ...f.parameters,
        sketchData: nextSketchData,
      },
    };
  });
}

function recalculateParameters(
  features: Feature[],
  userParameters: UserParameter[],
  dimensionParameters: DimensionParameter[]
): {
  ok: true;
  features: Feature[];
  userParameters: UserParameter[];
  dimensionParameters: DimensionParameter[];
} | {
  ok: false;
  message: string;
} {
  const env: Record<string, number> = {};
  const evaluatedUsers: UserParameter[] = [];
  for (const p of userParameters) {
    const res = evaluateExpression(p.expression, env, p.name);
    if (!res.ok) return { ok: false, message: `${p.name}: ${res.message}` };
    env[p.name] = res.value;
    evaluatedUsers.push({ ...p, resultValue: res.value });
  }

  let nextFeatures = features;
  const evaluatedDims: DimensionParameter[] = [];
  for (const d of dimensionParameters) {
    const res = evaluateExpression(d.expression, env, d.name);
    if (!res.ok) return { ok: false, message: `${d.name}: ${res.message}` };
    env[d.name] = res.value;
    nextFeatures = applyValueToDimensionTarget(nextFeatures, d, res.value);
    evaluatedDims.push({ ...d, resultValue: res.value });
  }

  return {
    ok: true,
    features: nextFeatures,
    userParameters: evaluatedUsers,
    dimensionParameters: buildDimensionParameters(nextFeatures, evaluatedDims),
  };
}

export const useCadStore = create<CadState>((set, get) => {
  cadWorker.postMessage({ type: 'INIT', id: 'init' });
  cadWorker.onmessage = (event) => {
    const { type, payload } = event.data;
    if (type === 'EVALUATE_DONE') {
      set({ meshes: payload.meshes });
    }
  };

  return {
    features: initialFeatures,
    meshes: [],
    solidResults: [],
    setSolidResults: (items) => set({ solidResults: items }),
    hiddenGeometryIds: [],
    toggleGeometryVisibility: (id) =>
      set((state) => ({
        hiddenGeometryIds: state.hiddenGeometryIds.includes(id)
          ? state.hiddenGeometryIds.filter((hiddenId) => hiddenId !== id)
          : [...state.hiddenGeometryIds, id],
      })),
    isGeometryVisible: (id) => !get().hiddenGeometryIds.includes(id),

    evaluateFeatures: () => {
      cadWorker.postMessage({ type: 'EVALUATE_FEATURE_TREE', payload: get().features, id: crypto.randomUUID() });
    },

    updateFeatureParameter: (id, param, value) => {
      set((state) => {
        const nextFeatures = state.features.map((f) =>
          f.id === id ? ({ ...f, parameters: { ...f.parameters, [param]: value } } as Feature) : f
        ) as Feature[];
        return {
          features: nextFeatures,
          dimensionParameters: buildDimensionParameters(nextFeatures, state.dimensionParameters),
        };
      });
    },

    addFeature: (feature) => {
      set((state) => {
        const nextFeatures = [...state.features, { ...feature, enabled: feature.enabled ?? true }];
        let hiddenGeometryIds = state.hiddenGeometryIds;
        if (
          feature.type === 'extrude' ||
          feature.type === 'cut' ||
          feature.type === 'revolve' ||
          feature.type === 'revolveCut'
        ) {
          const sid = feature.parameters.sketchId;
          if (sid && !hiddenGeometryIds.includes(sid)) {
            hiddenGeometryIds = [...hiddenGeometryIds, sid];
          }
        }
        return {
          features: nextFeatures,
          dimensionParameters: buildDimensionParameters(nextFeatures, state.dimensionParameters),
          hiddenGeometryIds,
        };
      });
    },

    deleteFeature: (id) => {
      set((state) => {
        const nextFeatures = state.features.filter((f) => f.id !== id);
        return {
          features: nextFeatures,
          selectedFeatureId: null,
          dimensionParameters: buildDimensionParameters(nextFeatures, state.dimensionParameters),
        };
      });
    },

    renameFeature: (id, name) => {
      set((state) => {
        const nextFeatures = state.features.map((f) => (f.id === id ? { ...f, name } : f));
        return {
          features: nextFeatures,
          dimensionParameters: buildDimensionParameters(nextFeatures, state.dimensionParameters),
        };
      });
    },
    toggleFeatureEnabled: (id) => {
      set((state) => {
        const target = state.features.find((f) => f.id === id);
        if (!target) return {};
        const nextEnabled = target.enabled === false;
        const disableSet = nextEnabled ? new Set<string>() : collectDependentFeatureIds(state.features, id);
        const nextFeatures = state.features.map((f) => {
          if (f.id === id) return { ...f, enabled: nextEnabled };
          if (!nextEnabled && disableSet.has(f.id)) return { ...f, enabled: false };
          return f;
        });
        return {
          features: nextFeatures,
          dimensionParameters: buildDimensionParameters(nextFeatures, state.dimensionParameters),
        };
      });
    },

    activeModule: 'part',
    setActiveModule: (module) => set({ activeModule: module, activeCommand: null, selectedFeatureId: null }),

    activeCommand: null,
    setActiveCommand: (command) => {
      const state = get();
      const selectedFeature = state.features.find((f) => f.id === state.selectedFeatureId);
      let preselection: string | null = null;

      if (
        command &&
        ['extrude', 'cut', 'revolve', 'revolveCut'].includes(command) &&
        selectedFeature?.type === 'sketch'
      ) {
        preselection = selectedFeature.id;
      } else if (command && ['extrude', 'cut', 'revolve', 'revolveCut'].includes(command)) {
        // Fallback: pick the most recently created sketch that actually has geometry.
        // This prevents defaulting to the initial empty XY sketch (f1).
        const sketches = state.features.filter((f): f is SketchFeature => f.type === 'sketch');
        const latestPopulated = [...sketches].reverse().find((s) => {
          const sd = s.parameters.sketchData;
          if (!sd) return false;
          return (
            (sd.points?.length ?? 0) > 0 ||
            (sd.lines?.length ?? 0) > 0 ||
            (sd.circles?.length ?? 0) > 0 ||
            (sd.arcs?.length ?? 0) > 0 ||
            (sd.bsplines?.length ?? 0) > 0
          );
        });
        preselection = latestPopulated?.id ?? sketches[sketches.length - 1]?.id ?? null;
      } else if (command && ['fillet', 'chamfer'].includes(command)) {
        if (selectedFeature && isSolidFeatureType(selectedFeature.type)) {
          preselection = selectedFeature.id;
        } else {
          const latestSolid = [...state.features].reverse().find((f) => isSolidFeatureType(f.type));
          preselection = latestSolid?.id ?? null;
        }
      }

      if (command && ['extrude', 'cut', 'revolve', 'revolveCut', 'fillet', 'chamfer'].includes(command)) {
        console.log('[CAD][SetActiveCommand]', {
          command,
          selectedFeatureId: state.selectedFeatureId,
          selectedFeatureType: selectedFeature?.type ?? null,
          commandPreselection: preselection,
        });
      }

      set({ activeCommand: command, selectedFeatureId: null, commandPreselection: preselection });
    },

    selectedFeatureId: null,
    setSelectedFeatureId: (id) => set({ selectedFeatureId: id, activeCommand: null }),

    selectedPlane: null,
    setSelectedPlane: (id) => set({
      selectedPlane: id,
      lastGeometricSelection: id
        ? { type: 'defaultPlane', name: id as 'xy' | 'xz' | 'yz', label: `${id.toUpperCase()} Plane` }
        : get().lastGeometricSelection,
    }),

    lastGeometricSelection: null,
    setLastGeometricSelection: (ref) => set({ lastGeometricSelection: ref }),
    selectionResetToken: 0,
    triggerSelectionReset: () => set((s) => ({ selectionResetToken: s.selectionResetToken + 1 })),

    activeSketchId: null,

    enterSketchMode: (sketchId) => {
      const feature = get().features.find((f) => f.id === sketchId) as SketchFeature | undefined;
      const sketchState = useSketchStore.getState();
      sketchState.clearSketch();
      if (feature?.parameters.sketchData) {
        sketchState.loadSketchData(feature.parameters.sketchData as any);
      }
      set({ activeModule: 'sketch', activeSketchId: sketchId, activeCommand: null, selectedFeatureId: null });
    },

    exitSketchMode: () => {
      const state = get();
      const sketchId = state.activeSketchId;
      if (sketchId) {
        const sketchData = useSketchStore.getState().getSketchData() as any;
        const nextFeatures = state.features.map((f) =>
          f.id === sketchId && f.type === 'sketch'
            ? ({ ...f, parameters: { ...f.parameters, sketchData } } as SketchFeature)
            : f
        ) as Feature[];
        set({
          features: nextFeatures,
          dimensionParameters: buildDimensionParameters(nextFeatures, get().dimensionParameters),
          activeModule: 'part',
          activeSketchId: null,
          activeCommand: null,
          // Keep the edited sketch selected so follow-up features (Extrude/Cut)
          // naturally preselect the intended profile.
          selectedFeatureId: sketchId,
        });
      } else {
        set({ activeModule: 'part', activeSketchId: null, activeCommand: null, selectedFeatureId: null });
      }
    },

    commandPreselection: null,
    setCommandPreselection: (id) => set({ commandPreselection: id }),

    activeInputField: null,
    activeInputOptions: null,

    activateGeometricInput: (fieldName, callback, options) => {
      _geoSelectionCb = callback;
      set({ activeInputField: fieldName, activeInputOptions: options ?? null });
    },

    captureGeometricSelection: (sel, keepActive = false) => {
      const cb = _geoSelectionCb;
      if (!keepActive) {
        _geoSelectionCb = null;
      }
      const planeLike =
        sel.type === 'defaultPlane' || sel.type === 'face' || sel.type === 'plane';
      set({
        ...(!keepActive ? { activeInputField: null, activeInputOptions: null } : {}),
        ...(planeLike ? { lastGeometricSelection: sel } : {}),
      });
      if (cb) cb(sel);
    },

    deactivateGeometricInput: () => {
      _geoSelectionCb = null;
      set({ activeInputField: null, activeInputOptions: null });
    },
    transientPreviewFeature: null,
    setTransientPreviewFeature: (feature) => {
      const sig = feature ? JSON.stringify(feature) : null;
      if (sig === _previewFeatureSig) return;
      _previewFeatureSig = sig;
      set({ transientPreviewFeature: feature });
    },

    showGrid: false,
    toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
    showOriginPlanes: true,
    toggleOriginPlanes: () => set((s) => ({ showOriginPlanes: !s.showOriginPlanes })),
    perspective: false,
    togglePerspective: () => set((s) => ({ perspective: !s.perspective })),
    pendingCameraView: null,
    setCameraView: (view) => set({ pendingCameraView: view }),
    clearPendingCameraView: () => set({ pendingCameraView: null }),

    commits: [
      { id: 'initial', message: 'Initial features', timestamp: Date.now(), features: initialFeatures },
    ],

    commitChanges: (message) => {
      set((state) => ({
        commits: [
          ...state.commits,
          {
            id: crypto.randomUUID(),
            message,
            timestamp: Date.now(),
            features: JSON.parse(JSON.stringify(state.features)),
          },
        ],
      }));
    },

    checkoutCommit: (commitId) => {
      const commit = get().commits.find((c) => c.id === commitId);
      if (commit) {
        const nextFeatures = JSON.parse(JSON.stringify(commit.features)) as Feature[];
        set({
          features: nextFeatures,
          dimensionParameters: buildDimensionParameters(nextFeatures, get().dimensionParameters),
        });
      }
    },

    isParametersDialogOpen: false,
    openParametersDialog: () => set({ isParametersDialogOpen: true }),
    closeParametersDialog: () => set({ isParametersDialogOpen: false }),
    userParameters: [],
    dimensionParameters: buildDimensionParameters(initialFeatures, []),

    addUserParameter: () => {
      const state = get();
      const existing = new Set([
        ...state.userParameters.map((p) => p.name.toUpperCase()),
        ...state.dimensionParameters.map((p) => p.name.toUpperCase()),
      ]);
      let i = 1;
      let next = `P${i}`;
      while (existing.has(next.toUpperCase())) {
        i += 1;
        next = `P${i}`;
      }
      set((s) => ({
        userParameters: [...s.userParameters, { id: crypto.randomUUID(), name: next, expression: '0', notes: '', resultValue: 0 }],
      }));
      return { success: true, message: 'Parameter added' };
    },

    updateUserParameter: (id, patch) => {
      const state = get();
      const current = state.userParameters.find((p) => p.id === id);
      if (!current) return { success: false, message: 'Parameter not found' };
      const nextName = (patch.name ?? current.name).trim();
      if (!nextName) return { success: false, message: 'Name is required' };
      const nameTakenByUser = state.userParameters.some((p) => p.id !== id && p.name.toUpperCase() === nextName.toUpperCase());
      const nameTakenByDim = state.dimensionParameters.some((p) => p.name.toUpperCase() === nextName.toUpperCase());
      if (nameTakenByUser || nameTakenByDim) return { success: false, message: 'Parameter name must be unique' };
      const patchedUsers = state.userParameters.map((p) =>
          p.id === id
            ? {
                ...p,
                ...(patch.name !== undefined ? { name: nextName } : {}),
                ...(patch.expression !== undefined ? { expression: patch.expression } : {}),
                ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
              }
            : p
        );
      const recalculated = recalculateParameters(state.features, patchedUsers, state.dimensionParameters);
      if (!recalculated.ok) return { success: false, message: recalculated.message };
      set({
        features: recalculated.features,
        userParameters: recalculated.userParameters,
        dimensionParameters: recalculated.dimensionParameters,
      });
      return { success: true, message: 'Parameter updated' };
    },

    updateDimensionParameter: (id, patch) => {
      const state = get();
      const target = state.dimensionParameters.find((d) => d.id === id);
      if (!target) return { success: false, message: 'Dimension parameter not found' };
      const patched = state.dimensionParameters.map((d) =>
        d.id === id
          ? {
              ...d,
              ...(patch.expression !== undefined ? { expression: patch.expression } : {}),
              ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
            }
          : d
      );
      const recalculated = recalculateParameters(state.features, state.userParameters, patched);
      if (!recalculated.ok) return { success: false, message: recalculated.message };
      set({
        features: recalculated.features,
        userParameters: recalculated.userParameters,
        dimensionParameters: recalculated.dimensionParameters,
      });
      return { success: true, message: 'Dimension parameter updated' };
    },

    linkDimensionExpression: (target, expression) => {
      const state = get();
      const trimmed = expression.trim();
      if (!trimmed.startsWith('=')) return { success: true, message: 'No expression link needed' };
      const patched = state.dimensionParameters.map((d) =>
        targetEquals(d.target, target) ? { ...d, expression: trimmed } : d
      );
      const recalculated = recalculateParameters(state.features, state.userParameters, patched);
      if (!recalculated.ok) return { success: false, message: recalculated.message };
      set({
        features: recalculated.features,
        userParameters: recalculated.userParameters,
        dimensionParameters: recalculated.dimensionParameters,
      });
      return { success: true, message: 'Expression linked' };
    },

    exportPartDocumentData: (meta) => {
      const state = get();
      return {
        kind: 'part',
        version: 1,
        meta,
        parameters: {
          userParameters: JSON.parse(JSON.stringify(state.userParameters)),
          dimensionParameters: JSON.parse(JSON.stringify(state.dimensionParameters)),
        },
        operations: JSON.parse(JSON.stringify(state.features)),
      };
    },

    importPartDocumentData: (doc) => {
      const features = JSON.parse(JSON.stringify(doc.operations)) as Feature[];
      const userParameters = JSON.parse(JSON.stringify(doc.parameters.userParameters ?? [])) as UserParameter[];
      const incomingDimensions = JSON.parse(JSON.stringify(doc.parameters.dimensionParameters ?? [])) as DimensionParameter[];
      const dimensionParameters = buildDimensionParameters(features, incomingDimensions);
      useSketchStore.getState().clearSketch();
      set({
        features,
        userParameters,
        dimensionParameters,
        activeModule: 'part',
        activeCommand: null,
        selectedFeatureId: null,
        selectedPlane: null,
        activeSketchId: null,
        commandPreselection: null,
        activeInputField: null,
        activeInputOptions: null,
        transientPreviewFeature: null,
      });
      get().evaluateFeatures();
    },

    resetDocument: () => {
      const features = cloneInitialFeatures();
      useSketchStore.getState().clearSketch();
      set({
        features,
        meshes: [],
        solidResults: [],
        hiddenGeometryIds: [],
        activeModule: 'part',
        activeCommand: null,
        selectedFeatureId: null,
        selectedPlane: null,
        lastGeometricSelection: null,
        activeSketchId: null,
        commandPreselection: null,
        activeInputField: null,
        activeInputOptions: null,
        transientPreviewFeature: null,
        commits: [{ id: 'initial', message: 'Initial features', timestamp: Date.now(), features }],
        userParameters: [],
        dimensionParameters: buildDimensionParameters(features, []),
      });
      get().evaluateFeatures();
    },
  };
});
