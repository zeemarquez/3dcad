import type {
  Feature,
  SketchFeature,
  ExtrudeFeature,
  CutFeature,
  RevolveFeature,
  RevolveCutFeature,
  FilletFeature,
  ChamferFeature,
} from '../store/useCadStore';
import type { FeatureInput, RevolveFeatureInput } from './cadEngine';
import { getAxisLineFromAxisFeatureId } from './axisFeatureLine';

/**
 * Same ordering and fields as the 3D viewport CAD build — must include fillet/chamfer
 * so sketch overlays match the displayed solid (chamfer edges, etc.).
 */
export function featuresToCadFeatureInputs(sourceFeatures: Feature[]): FeatureInput[] {
  const sketchMap = new Map<string, SketchFeature>(
    sourceFeatures
      .filter((f): f is SketchFeature => f.type === 'sketch' && f.enabled !== false)
      .map((f) => [f.id, f]),
  );
  const featureInputs: FeatureInput[] = [];
  for (const feature of sourceFeatures) {
    if (feature.enabled === false) continue;
    if (feature.type === 'extrude' || feature.type === 'cut') {
      const ef = feature as ExtrudeFeature | CutFeature;
      const height = Math.max(
        Number(
          feature.type === 'extrude'
            ? (ef as ExtrudeFeature).parameters.height
            : (ef as CutFeature).parameters.depth,
        ) || 10,
        0.001,
      );
      const sketch = sketchMap.get(ef.parameters.sketchId);
      const sd = sketch?.parameters?.sketchData;
      if (!sd) continue;
      const plane = sketch?.parameters?.plane ?? 'xy';
      const sketchOffset = Number(sketch?.parameters?.planeOffset) || 0;
      const planeRef = sketch?.parameters?.planeRef ?? null;
      const { reverse, symmetric, startOffset } = ef.parameters;

      featureInputs.push({
        id: feature.id,
        name: feature.name,
        type: feature.type as 'extrude' | 'cut',
        sketchData: sd as any,
        plane,
        height,
        reverse: !!reverse,
        symmetric: !!symmetric,
        startOffset: Number(startOffset) || 0,
        planeOffset: sketchOffset,
        planeRef,
      });
    } else if (feature.type === 'revolve' || feature.type === 'revolveCut') {
      const rf = feature as RevolveFeature | RevolveCutFeature;
      const sketch = sketchMap.get(rf.parameters.sketchId);
      const sd = sketch?.parameters?.sketchData;
      if (!sd) continue;
      const plane = sketch?.parameters?.plane ?? 'xy';
      const sketchOffset = Number(sketch?.parameters?.planeOffset) || 0;
      const planeRef = sketch?.parameters?.planeRef ?? null;
      const angle = Math.max(Math.abs(Number(rf.parameters.angle) || 360), 0.001);
      const startOff = Number(rf.parameters.startOffset) || 0;

      const ra = rf.parameters.revolveAxis;
      let axis: 'x' | 'y' | 'z' = 'z';
      let revolveAxisMode: RevolveFeatureInput['revolveAxisMode'] = 'world';
      let edgeAxis: RevolveFeatureInput['edgeAxis'];
      let axisFeatureLine: RevolveFeatureInput['axisFeatureLine'];

      if (ra?.type === 'edge') {
        revolveAxisMode = 'edge';
        axis = 'z';
        edgeAxis = {
          direction: [ra.direction[0], ra.direction[1], ra.direction[2]],
          midpoint: [ra.midpoint[0], ra.midpoint[1], ra.midpoint[2]],
        };
      } else if (ra?.type === 'axisFeature') {
        const line = getAxisLineFromAxisFeatureId(ra.featureId, sourceFeatures);
        if (line) {
          revolveAxisMode = 'axisFeature';
          axis = 'z';
          axisFeatureLine = line;
        } else {
          const ax = rf.parameters.axis;
          axis = ax === 'x' || ax === 'y' || ax === 'z' ? ax : 'z';
          revolveAxisMode = 'world';
          console.warn('[CAD] Revolve axis feature could not be resolved; using world axis', rf.parameters.axis);
        }
      } else if (ra?.type === 'worldAxis') {
        revolveAxisMode = 'world';
        axis = ra.axis;
      } else {
        const ax = rf.parameters.axis;
        axis = ax === 'x' || ax === 'y' || ax === 'z' ? ax : 'z';
        revolveAxisMode = 'world';
      }

      featureInputs.push({
        id: feature.id,
        name: feature.name,
        type: feature.type === 'revolveCut' ? 'revolveCut' : 'revolve',
        sketchData: sd as any,
        plane,
        planeOffset: sketchOffset,
        planeRef,
        startOffset: startOff,
        angle,
        axis,
        revolveAxisMode,
        edgeAxis,
        axisFeatureLine,
      });
    } else if (feature.type === 'fillet' || feature.type === 'chamfer') {
      const bf = feature as FilletFeature | ChamferFeature;
      featureInputs.push({
        id: feature.id,
        name: feature.name,
        type: feature.type,
        targetFeatureId: bf.parameters.targetFeatureId,
        value: Math.max(
          Number(
            feature.type === 'fillet'
              ? (bf as FilletFeature).parameters.radius
              : (bf as ChamferFeature).parameters.distance,
          ) || 1,
          0.001,
        ),
        selectedEdgeMidpoints: (bf.parameters.edges ?? []).map((e) => e.midpoint),
        selectedEdgeBoxes: (bf.parameters.edges ?? []).map((e) => e.bbox ?? { min: e.midpoint, max: e.midpoint }),
      });
    }
  }
  return featureInputs;
}
