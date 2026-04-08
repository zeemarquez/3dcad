import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Grid, Line } from '@react-three/drei';
import {
  useCadStore,
  type GeometricSelectionRef,
  type SketchFeature,
  type ExtrudeFeature,
  type CutFeature,
  type AxisFeature,
  type PlaneFeature,
  type PointFeature,
  type FilletFeature,
  type ChamferFeature,
} from '../store/useCadStore';
import * as THREE from 'three';
import {
  initCAD,
  isCADReady,
  buildAllSolids,
  buildPreviewDifferenceSolids,
  type SolidMeshData,
  type FeatureInput,
} from '../lib/cadEngine';
import { getSketchPlaneBasis, sketch2DToWorld } from '../lib/sketchPlaneBasis';

const C_BASE     = '#bfdbfe';
const C_FACE_HOV = '#93c5fd';
const C_SEL      = '#f59e0b';
const C_EDGE     = '#334155';
const C_EDGE_HOV = '#38bdf8';
type ActiveSelectionKind = 'any' | 'planeFace' | 'edge' | 'point' | 'sketch' | 'none';

function selectionKindFromField(field: string | null): ActiveSelectionKind {
  if (!field) return 'any';
  if (field.endsWith('Edges')) return 'edge';
  if (field.startsWith('sketch_')) return 'sketch';
  if (field.toLowerCase().includes('point')) return 'point';
  if (
    field === 'sketchPlane' ||
    field === 'sketchPlaneEdit' ||
    field.includes('Plane') ||
    field === 'planeRef'
  ) return 'planeFace';
  return 'any';
}

function sampleArcPoints2D(
  center: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
  maxSegAngle = Math.PI / 24,
): { x: number; y: number }[] {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  if (r < 1e-8) return [start, end];
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  let sweep = a1 - a0;
  if (sweep < 0) sweep += Math.PI * 2; // sketch-store semantics are CCW start->end
  const segs = Math.max(2, Math.ceil(sweep / maxSegAngle));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (sweep * i) / segs;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

function signedArea2D(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return 0.5 * a;
}

function pointInPoly2D(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const hit = ((yi > p.y) !== (yj > p.y))
      && (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-12) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

// ──────────────────────────────────────────────────────────────────────────────
// B-Rep face data — one per topological face from OpenCascade
// ──────────────────────────────────────────────────────────────────────────────
interface BRepFace {
  groupId: number;
  faceId: number;
  geo: THREE.BufferGeometry;
  normal: THREE.Vector3;
}

interface FacePickData {
  pickType: 'brepFace';
  face: BRepFace;
  featureId: string;
  featureName: string;
}

function deriveAxisAlignedFaceRef(
  face: BRepFace,
  hitPoint?: THREE.Vector3,
): { normal: THREE.Vector3; faceOffset: number } {
  const pos = face.geo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  if (!count) return { normal: new THREE.Vector3(0, 0, 1), faceOffset: 0 };

  let sumX = 0, sumY = 0, sumZ = 0;
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    sumX += x; sumY += y; sumZ += z;
  }
  const cx = sumX / count, cy = sumY / count, cz = sumZ / count;
  const p = hitPoint ?? new THREE.Vector3(cx, cy, cz);

  // Preserve the actual face normal (including inclined faces) and
  // store d in n·p=d using the click point (or centroid fallback).
  const normal = face.normal.clone();
  if (normal.lengthSq() < 1e-12) return { normal: new THREE.Vector3(0, 0, 1), faceOffset: 0 };
  normal.normalize();
  const faceOffset = normal.dot(p);
  console.log('[CAD][FaceRef] exact', {
    groupId: face.groupId,
    faceId: face.faceId,
    faceNormal: [face.normal.x, face.normal.y, face.normal.z],
    normal: [normal.x, normal.y, normal.z],
    hitPoint: [p.x, p.y, p.z],
    faceOffset,
  });
  return { normal, faceOffset };
}

function buildFaceSelectionRef(
  face: BRepFace,
  featureId: string,
  featureName: string,
  hitPoint?: THREE.Vector3,
): GeometricSelectionRef {
  const refPlane = deriveAxisAlignedFaceRef(face, hitPoint);
  return {
    type: 'face',
    featureId,
    featureName,
    normal: [refPlane.normal.x, refPlane.normal.y, refPlane.normal.z],
    faceOffset: Math.abs(refPlane.faceOffset) < 1e-6 ? 0 : refPlane.faceOffset,
    label: `${featureName} — Face`,
  };
}

function buildFacesFromMesh(data: SolidMeshData): BRepFace[] {
  const { vertices, normals, triangles, faceGroups } = data;
  const result: BRepFace[] = [];

  for (let gi = 0; gi < faceGroups.length; gi++) {
    const fg = faceGroups[gi];

    // fg.start = flat start index into the triangles[] index array
    // fg.count = number of INDEX entries (not triangles!), so fg.count/3 = triangles
    // This matches THREE.js BufferGeometry.groups convention.
    const numIdx = fg.count;                       // e.g. 12 for 4 triangles
    const posArr = new Float32Array(numIdx * 3);   // 3 floats per vertex
    const norArr = new Float32Array(numIdx * 3);

    for (let fi = 0; fi < numIdx; fi++) {
      const idx = triangles[fg.start + fi];        // vertex index
      posArr[fi * 3]     = vertices[idx * 3];
      posArr[fi * 3 + 1] = vertices[idx * 3 + 1];
      posArr[fi * 3 + 2] = vertices[idx * 3 + 2];
      norArr[fi * 3]     = normals[idx * 3];
      norArr[fi * 3 + 1] = normals[idx * 3 + 1];
      norArr[fi * 3 + 2] = normals[idx * 3 + 2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(norArr, 3));

    // Average normal for selection plane detection
    const avg = new THREE.Vector3();
    for (let fi = 0; fi < numIdx; fi++) avg.add(new THREE.Vector3(norArr[fi * 3], norArr[fi * 3 + 1], norArr[fi * 3 + 2]));
    avg.normalize();

    result.push({ groupId: gi, faceId: fg.faceId, geo, normal: avg });
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// B-Rep edges — exact topological edges from OpenCascade (polylines)
// ──────────────────────────────────────────────────────────────────────────────
interface BRepEdge {
  id: number;
  points: THREE.Vector3[];
  mid: [number, number, number];
  dir: [number, number, number];
}

function buildEdgesFromMesh(data: SolidMeshData): BRepEdge[] {
  const { edgeVertices, edgeGroupStarts } = data;
  if (edgeVertices.length < 6) return [];
  const totalPoints = edgeVertices.length / 3;
  const groups = edgeGroupStarts.length
    ? edgeGroupStarts.map((start, i) => ({
        start,
        end: i + 1 < edgeGroupStarts.length ? edgeGroupStarts[i + 1] : totalPoints,
      }))
    : [{ start: 0, end: totalPoints }];

  const out: BRepEdge[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const chunk = edgeVertices.subarray(g.start * 3, g.end * 3);
    if (chunk.length < 6) continue;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i + 5 < chunk.length; i += 6) {
      const a = new THREE.Vector3(chunk[i], chunk[i + 1], chunk[i + 2]);
      const b = new THREE.Vector3(chunk[i + 3], chunk[i + 4], chunk[i + 5]);
      if (pts.length === 0) pts.push(a, b);
      else {
        const last = pts[pts.length - 1];
        if (last.distanceTo(a) < 1e-4) pts.push(b);
        else pts.push(a, b);
      }
    }
    if (pts.length < 2) continue;
    const m = pts[Math.floor(pts.length / 2)];
    const start = pts[0];
    const end = pts[pts.length - 1];
    const d = end.clone().sub(start);
    const len = d.length();
    if (len > 1e-6) d.divideScalar(len);
    out.push({ id: gi, points: pts, mid: [m.x, m.y, m.z], dir: [d.x, d.y, d.z] });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// EdgeLine — renders a single B-Rep edge (polyline) as a selectable line
// ──────────────────────────────────────────────────────────────────────────────
interface EdgeLineProps {
  edge: BRepEdge;
  hovered: boolean;
  selected: boolean;
  inSelMode: boolean;
  selectable: boolean;
  preview: boolean;
  previewColor?: string;
  ghost?: boolean;
  faded?: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onSelect: (ctrlKey: boolean) => void;
}
const EdgeLine: React.FC<EdgeLineProps> = ({
  edge, hovered, selected, inSelMode, selectable, preview, previewColor, ghost = false, faded = false, onEnter, onLeave, onSelect,
}) => {
  const effectiveHover = selectable && hovered;
  const color = ghost
    ? '#94a3b8'
    : preview
    ? (previewColor ?? '#86efac')
    : selected
    ? C_SEL
    : effectiveHover
    ? (inSelMode ? C_SEL : C_EDGE_HOV)
    : C_EDGE;
  const pickLineWidth = inSelMode ? 12 : 8;
  return (
    <>
      {/* Invisible wide line to make edge picking more forgiving */}
      <Line
        points={edge.points}
        color="#000000"
        lineWidth={pickLineWidth}
        transparent
        opacity={0}
        renderOrder={1}
        onPointerOver={(e) => { e.stopPropagation(); if (selectable) onEnter(); }}
        onPointerOut={(e) => { e.stopPropagation(); if (selectable) onLeave(); }}
        onClick={(e) => {
          e.stopPropagation();
          if (selectable) onSelect(!!(e.ctrlKey || e.shiftKey || e.metaKey));
        }}
      />
      <Line
        points={edge.points}
        color={color}
        lineWidth={effectiveHover || selected ? 3 : 1.5}
        transparent={preview || faded}
        opacity={preview ? 0.7 : faded ? 0.45 : 1}
        renderOrder={2}
      />
    </>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// FaceMesh — a single selectable/hoverable B-Rep face
// ──────────────────────────────────────────────────────────────────────────────
interface FaceMeshProps {
  face: BRepFace;
  featureId: string;
  featureName: string;
  selected: boolean;
  inSelMode: boolean;
  selectable: boolean;
  preview: boolean;
  previewColor?: string;
  ghost?: boolean;
  faded?: boolean;
  onSelect: (hitPoint: THREE.Vector3, ctrlKey: boolean) => void;
  onHoverStart: () => void;
  onHoverEnd: () => void;
}
const FaceMesh: React.FC<FaceMeshProps> = ({
  face,
  featureId,
  featureName,
  selected,
  inSelMode,
  selectable,
  preview,
  previewColor,
  ghost = false,
  faded = false,
  onSelect,
  onHoverStart,
  onHoverEnd,
}) => {
  const [hovered, setHovered] = useState(false);
  const effectiveHover = selectable && hovered;
  const color = ghost
    ? '#cbd5e1'
    : preview
    ? (previewColor ?? '#86efac')
    : selected
    ? C_SEL
    : effectiveHover
    ? (inSelMode ? C_SEL : C_FACE_HOV)
    : C_BASE;

  return (
    <mesh
      geometry={face.geo}
      userData={selectable ? { pickType: 'brepFace', face, featureId, featureName } : {}}
      onPointerOver={(e) => { e.stopPropagation(); if (selectable) { setHovered(true); onHoverStart(); } }}
      onPointerOut={(e) => { e.stopPropagation(); if (selectable) { setHovered(false); onHoverEnd(); } }}
      onClick={(e) => {
        e.stopPropagation();
        if (selectable) onSelect(e.point.clone(), !!(e.ctrlKey || e.shiftKey || e.metaKey));
      }}
    >
      <meshStandardMaterial
        color={color}
        transparent={preview || faded || ghost}
        opacity={preview ? 0.4 : ghost ? 0.26 : faded ? 0.5 : 1}
        roughness={0.3}
        metalness={0.05}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={1}
        polygonOffsetUnits={1}
      />
    </mesh>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// SolidMesh — renders one B-Rep solid with face meshes + edge lines
// ──────────────────────────────────────────────────────────────────────────────
interface SolidMeshProps {
  solidData: SolidMeshData;
  selectable?: boolean;
  preview?: boolean;
  previewColor?: string;
  ghost?: boolean;
  faded?: boolean;
}

const SolidMesh: React.FC<SolidMeshProps> = ({ solidData, selectable = true, preview = false, previewColor, ghost = false, faded = false }) => {
  const { activeInputField, captureGeometricSelection, setLastGeometricSelection, selectionResetToken } = useCadStore();
  const inSelMode = !!activeInputField;
  const selectionKind = selectionKindFromField(activeInputField);
  const allowFaceSelection = selectable && (!inSelMode || selectionKind === 'any' || selectionKind === 'planeFace');
  const allowEdgeSelection = selectable && (!inSelMode || selectionKind === 'any' || selectionKind === 'edge');

  const faces = useMemo(() => buildFacesFromMesh(solidData), [solidData]);
  const edges = useMemo(() => buildEdgesFromMesh(solidData), [solidData]);

  const [selFaceId, setSelFaceId] = useState<number | null>(null);
  const [hovEdge, setHovEdge] = useState<number | null>(null);
  const [selEdge, setSelEdge] = useState<number | null>(null);

  useEffect(() => {
    setSelFaceId(null);
    setSelEdge(null);
    setHovEdge(null);
  }, [selectionResetToken]);

  const handleFaceSelect = useCallback(
    (face: BRepFace, hitPoint?: THREE.Vector3, ctrlKey = false) => {
      const ref = buildFaceSelectionRef(face, solidData.featureId, solidData.featureName, hitPoint);
      console.log('[CAD][FaceSelect]', {
        featureId: solidData.featureId,
        featureName: solidData.featureName,
        inSelectionMode: inSelMode,
        ref,
      });
      if (inSelMode) {
        captureGeometricSelection(ref, ctrlKey);
      } else {
        setLastGeometricSelection(ref);
        setSelFaceId((prev) => (prev === face.groupId ? null : face.groupId));
        setSelEdge(null);
      }
    },
    [inSelMode, solidData.featureId, solidData.featureName, captureGeometricSelection, setLastGeometricSelection],
  );

  const makeEdgeHandlers = useCallback(
    (edge: BRepEdge) => ({
      onEnter: () => setHovEdge(edge.id),
      onLeave: () => setHovEdge(null),
      onSelect: (ctrlKey: boolean) => {
        if (inSelMode) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (const p of edge.points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.z < minZ) minZ = p.z;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
            if (p.z > maxZ) maxZ = p.z;
          }
          captureGeometricSelection({
            type: 'edge',
            featureId: solidData.featureId,
            featureName: solidData.featureName,
            direction: edge.dir,
            midpoint: edge.mid,
            bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
            label: `${solidData.featureName} — Edge`,
          }, ctrlKey);
        } else {
          setSelEdge((prev) => (prev === edge.id ? null : edge.id));
          setSelFaceId(null);
        }
      },
    }),
    [inSelMode, solidData.featureId, solidData.featureName, captureGeometricSelection],
  );

  return (
    <group>
      {faces.map((face) => (
        <FaceMesh
          key={`f${face.groupId}`}
          face={face}
          featureId={solidData.featureId}
          featureName={solidData.featureName}
          selected={selFaceId === face.groupId}
          inSelMode={inSelMode}
          selectable={allowFaceSelection}
          preview={preview}
          previewColor={previewColor}
          ghost={ghost}
          faded={faded}
          onSelect={(hitPoint, ctrlKey) => handleFaceSelect(face, hitPoint, ctrlKey)}
          onHoverStart={() => {}}
          onHoverEnd={() => {}}
        />
      ))}
      {edges.map((edge) => (
        <EdgeLine
          key={`e${edge.id}`}
          edge={edge}
          hovered={hovEdge === edge.id}
          selected={selEdge === edge.id}
          inSelMode={inSelMode}
          selectable={allowEdgeSelection}
          preview={preview}
          previewColor={previewColor}
          ghost={ghost}
          faded={faded}
          {...makeEdgeHandlers(edge)}
        />
      ))}
    </group>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// CADSolids — uses replicad / OpenCascade.js B-Rep kernel for clean geometry
// ──────────────────────────────────────────────────────────────────────────────
const CADSolids = () => {
  const features = useCadStore((s) => s.features);
  const hiddenGeometryIds = useCadStore((s) => s.hiddenGeometryIds);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const activeCommand = useCadStore((s) => s.activeCommand);
  const transientPreviewFeature = useCadStore((s) => s.transientPreviewFeature);
  const setSolidResults = useCadStore((s) => s.setSolidResults);
  const [cadReady, setCadReady] = useState(isCADReady());
  const [solids, setSolids] = useState<SolidMeshData[]>([]);
  const [beforeSolids, setBeforeSolids] = useState<SolidMeshData[]>([]);
  const [previewSolids, setPreviewSolids] = useState<SolidMeshData[]>([]);
  const [previewColor, setPreviewColor] = useState<string>('#86efac');

  const toFeatureInputs = useCallback((sourceFeatures: typeof features): FeatureInput[] => {
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
      } else if (feature.type === 'fillet' || feature.type === 'chamfer') {
        const bf = feature as FilletFeature | ChamferFeature;
        featureInputs.push({
          id: feature.id,
          name: feature.name,
          type: feature.type,
          targetFeatureId: bf.parameters.targetFeatureId,
          value: Math.max(
            Number(feature.type === 'fillet' ? (bf as FilletFeature).parameters.radius : (bf as ChamferFeature).parameters.distance) || 1,
            0.001,
          ),
          selectedEdgeMidpoints: (bf.parameters.edges ?? []).map((e) => e.midpoint),
          selectedEdgeBoxes: (bf.parameters.edges ?? []).map((e) =>
            e.bbox ?? { min: e.midpoint, max: e.midpoint }
          ),
        });
      }
    }
    return featureInputs;
  }, []);

  useEffect(() => {
    if (!cadReady) {
      initCAD().then(() => setCadReady(true)).catch((e) => console.error('CAD init failed:', e));
    }
  }, [cadReady]);

  useEffect(() => {
    if (!cadReady) return;
    try {
      const featureInputs = toFeatureInputs(features);
      const result = buildAllSolids(featureInputs);
      setSolids(result);
      setSolidResults(
        result.map((solid, index) => ({
          geometryId: `${solid.featureId}:${index}`,
          featureId: solid.featureId,
          featureName: solid.featureName,
        }))
      );

      const selectedIndex = selectedFeatureId ? features.findIndex((f) => f.id === selectedFeatureId) : -1;
      const selectedFeature = selectedIndex >= 0 ? features[selectedIndex] : null;
      const editableSolidFeature =
        !!selectedFeature &&
        ['extrude', 'cut', 'revolve', 'fillet', 'chamfer'].includes(selectedFeature.type);
      const canPreviewCreate =
        !selectedFeature &&
        !!activeCommand &&
        ['extrude', 'cut', 'revolve', 'fillet', 'chamfer'].includes(activeCommand) &&
        !!transientPreviewFeature;
      if (editableSolidFeature && selectedFeature) {
        const opType = selectedFeature.type;
        setPreviewColor(['cut', 'fillet', 'chamfer'].includes(opType) ? '#f87171' : '#86efac');
        const beforeInputs = toFeatureInputs(features.slice(0, selectedIndex));
        const before = buildAllSolids(beforeInputs);
        const afterInputs = toFeatureInputs(features.slice(0, selectedIndex + 1));
        const preview = buildPreviewDifferenceSolids(beforeInputs, afterInputs);
        setBeforeSolids(before);
        setPreviewSolids(preview);
      } else if (canPreviewCreate && transientPreviewFeature) {
        setPreviewColor(['cut', 'fillet', 'chamfer'].includes(activeCommand ?? '') ? '#f87171' : '#86efac');
        const beforeInputs = toFeatureInputs(features);
        const before = buildAllSolids(beforeInputs);
        const afterInputs = toFeatureInputs([...features, transientPreviewFeature]);
        const preview = buildPreviewDifferenceSolids(beforeInputs, afterInputs);
        setBeforeSolids(before);
        setPreviewSolids(preview);
      } else {
        setPreviewColor('#86efac');
        setBeforeSolids([]);
        setPreviewSolids([]);
      }
    } catch (e) {
      console.error('B-Rep build failed:', e);
      setSolidResults([]);
      setBeforeSolids([]);
      setPreviewSolids([]);
    }
  }, [cadReady, features, selectedFeatureId, activeCommand, transientPreviewFeature, setSolidResults, toFeatureInputs]);

  if (!cadReady) return null;

  return (
    <>
      {beforeSolids.length > 0 || previewSolids.length > 0 ? (
        <>
          {beforeSolids.map((sd, i) => (
            hiddenGeometryIds.includes(`${sd.featureId}:${i}`)
              ? null
              : <SolidMesh key={`before_${sd.featureId}_${i}`} solidData={sd} selectable ghost />
          ))}
          {previewSolids.map((sd, i) => (
            <SolidMesh key={`preview_${sd.featureId}_${i}`} solidData={sd} selectable={false} preview previewColor={previewColor} />
          ))}
        </>
      ) : (
        solids.map((sd, i) => (
          hiddenGeometryIds.includes(`${sd.featureId}:${i}`) ? null : <SolidMesh key={`${sd.featureId}_${i}`} solidData={sd} selectable />
        ))
      )}
    </>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Sketch Wireframes
// ──────────────────────────────────────────────────────────────────────────────
const SketchWireframes = () => {
  const { features, activeInputField, captureGeometricSelection, selectionResetToken } = useCadStore();
  const activeSketchId = useCadStore((s) => s.activeSketchId);
  const hiddenGeometryIds = useCadStore((s) => s.hiddenGeometryIds);
  const inSelMode = !!activeInputField;
  const selectionKind = selectionKindFromField(activeInputField);
  const allowSketchSelection = inSelMode && (selectionKind === 'any' || selectionKind === 'sketch');
  const [hoveredSketchId, setHoveredSketchId] = useState<string | null>(null);
  const [selectedSketchId, setSelectedSketchId] = useState<string | null>(null);
  useEffect(() => {
    setHoveredSketchId(null);
    setSelectedSketchId(null);
  }, [selectionResetToken]);
  const wireframes = useMemo(() => {
    const results: { id: string; name: string; positions: Float32Array; fills: THREE.BufferGeometry[] }[] = [];
    for (const f of features) {
      if (f.enabled === false) continue;
      if (f.type !== 'sketch' || f.id === activeSketchId || hiddenGeometryIds.includes(f.id)) continue;
      const skf = f as SketchFeature;
      const sd = skf.parameters.sketchData;
      if (!sd?.points) continue;
      const ptMap = new Map(sd.points.map((p) => [p.id, p]));
      const verts: number[] = [];
      const fillGeos: THREE.BufferGeometry[] = [];
      const basis = getSketchPlaneBasis(skf);
      const fillMat = new THREE.Matrix4();
      fillMat.makeBasis(
        new THREE.Vector3(basis.u[0], basis.u[1], basis.u[2]),
        new THREE.Vector3(basis.v[0], basis.v[1], basis.v[2]),
        new THREE.Vector3(basis.n[0], basis.n[1], basis.n[2]),
      );
      fillMat.setPosition(basis.origin[0], basis.origin[1], basis.origin[2]);
      for (const line of sd.lines ?? []) {
        const p1 = ptMap.get(line.p1Id),
          p2 = ptMap.get(line.p2Id);
        if (!p1 || !p2) continue;
        const [x1, y1, z1] = sketch2DToWorld(skf, p1.x, p1.y),
          [x2, y2, z2] = sketch2DToWorld(skf, p2.x, p2.y);
        verts.push(x1, y1, z1, x2, y2, z2);
      }
      for (const circ of sd.circles ?? []) {
        const c = ptMap.get(circ.centerId);
        if (!c) continue;
        for (let i = 0; i < 64; i++) {
          const a1 = (i / 64) * Math.PI * 2,
            a2 = ((i + 1) / 64) * Math.PI * 2;
          const [x1, y1, z1] = sketch2DToWorld(
            skf,
            c.x + circ.radius * Math.cos(a1),
            c.y + circ.radius * Math.sin(a1),
          );
          const [x2, y2, z2] = sketch2DToWorld(
            skf,
            c.x + circ.radius * Math.cos(a2),
            c.y + circ.radius * Math.sin(a2),
          );
          verts.push(x1, y1, z1, x2, y2, z2);
        }
      }
      for (const arc of sd.arcs ?? []) {
        const c = ptMap.get(arc.centerId);
        const s = ptMap.get(arc.startId);
        const e = ptMap.get(arc.endId);
        if (!c || !s || !e) continue;
        const r = Math.hypot(s.x - c.x, s.y - c.y);
        if (r < 1e-8) continue;
        const a0 = Math.atan2(s.y - c.y, s.x - c.x);
        const a1 = Math.atan2(e.y - c.y, e.x - c.x);
        // Arc semantics are CCW start -> end in sketch store.
        let sweep = a1 - a0;
        if (sweep < 0) sweep += Math.PI * 2;
        const segs = Math.max(8, Math.ceil(sweep / (Math.PI / 24)));
        for (let i = 0; i < segs; i++) {
          const t1 = i / segs, t2 = (i + 1) / segs;
          const aa = a0 + sweep * t1;
          const bb = a0 + sweep * t2;
          const [x1, y1, z1] = sketch2DToWorld(skf, c.x + r * Math.cos(aa), c.y + r * Math.sin(aa));
          const [x2, y2, z2] = sketch2DToWorld(skf, c.x + r * Math.cos(bb), c.y + r * Math.sin(bb));
          verts.push(x1, y1, z1, x2, y2, z2);
        }
      }

      // Filled regions in 3D (same concept as sketch mode): detect closed loops and holes.
      // Build mixed loops from lines + arcs, plus full circles.
      type LoopEdge = { id: string; a: string; b: string; path: { x: number; y: number }[] };
      type LoopPoly = {
        id: string;
        pts: { x: number; y: number }[];
        areaAbs: number;
        centroid: { x: number; y: number };
        bbox: { minX: number; minY: number; maxX: number; maxY: number };
      };
      const edges: LoopEdge[] = [];
      for (const l of sd.lines ?? []) {
        const p1 = ptMap.get(l.p1Id), p2 = ptMap.get(l.p2Id);
        if (!p1 || !p2) continue;
        edges.push({ id: `l_${l.id}`, a: l.p1Id, b: l.p2Id, path: [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }] });
      }
      for (const a of sd.arcs ?? []) {
        const c = ptMap.get(a.centerId), s = ptMap.get(a.startId), e = ptMap.get(a.endId);
        if (!c || !s || !e) continue;
        const path = sampleArcPoints2D({ x: c.x, y: c.y }, { x: s.x, y: s.y }, { x: e.x, y: e.y });
        if (path.length < 2) continue;
        edges.push({ id: `a_${a.id}`, a: a.startId, b: a.endId, path });
      }
      const loops: LoopPoly[] = [];
      const adj = new Map<string, { edgeId: string; other: string }[]>();
      for (const e of edges) {
        if (!adj.has(e.a)) adj.set(e.a, []);
        if (!adj.has(e.b)) adj.set(e.b, []);
        adj.get(e.a)!.push({ edgeId: e.id, other: e.b });
        adj.get(e.b)!.push({ edgeId: e.id, other: e.a });
      }
      const byId = new Map(edges.map((e) => [e.id, e]));
      const used = new Set<string>();
      let loopIdx = 0;
      for (const seed of edges) {
        if (used.has(seed.id)) continue;
        const startNode = seed.a;
        let curNode = seed.b;
        let prevNode = seed.a;
        const thisUsed = new Set<string>([seed.id]);
        const pts = [...seed.path];
        while (curNode !== startNode) {
          const nbrs = (adj.get(curNode) ?? []).filter((n) => !thisUsed.has(n.edgeId));
          if (!nbrs.length) break;
          const next = nbrs.find((n) => n.other !== prevNode) ?? nbrs[0];
          const seg = byId.get(next.edgeId);
          if (!seg) break;
          thisUsed.add(seg.id);
          const forward = seg.a === curNode;
          pts.push(...(forward ? seg.path : [...seg.path].reverse()).slice(1));
          prevNode = curNode;
          curNode = next.other;
        }
        if (curNode === startNode && pts.length >= 3) {
          for (const id of thisUsed) used.add(id);
          const first = pts[0], last = pts[pts.length - 1];
          const clean = Math.hypot(first.x - last.x, first.y - last.y) < 1e-8 ? pts.slice(0, -1) : pts;
          const areaAbs = Math.abs(signedArea2D(clean));
          if (areaAbs > 1e-8) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let cx = 0, cy = 0;
            for (const p of clean) {
              if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
              if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
              cx += p.x; cy += p.y;
            }
            loops.push({
              id: `m_${loopIdx++}`,
              pts: clean,
              areaAbs,
              centroid: { x: cx / clean.length, y: cy / clean.length },
              bbox: { minX, minY, maxX, maxY },
            });
          }
        }
      }
      for (const c of sd.circles ?? []) {
        const center = ptMap.get(c.centerId);
        if (!center || c.radius <= 1e-8) continue;
        const segs = 72;
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          pts.push({ x: center.x + c.radius * Math.cos(a), y: center.y + c.radius * Math.sin(a) });
        }
        loops.push({
          id: `c_${c.id}`,
          pts,
          areaAbs: Math.PI * c.radius * c.radius,
          centroid: { x: center.x, y: center.y },
          bbox: { minX: center.x - c.radius, minY: center.y - c.radius, maxX: center.x + c.radius, maxY: center.y + c.radius },
        });
      }
      const depth = new Map<string, number>();
      const parent = new Map<string, string | null>();
      for (const l of loops) {
        let bestParent: LoopPoly | null = null;
        for (const cand of loops) {
          if (cand.id === l.id || cand.areaAbs <= l.areaAbs) continue;
          if (
            l.bbox.minX < cand.bbox.minX || l.bbox.maxX > cand.bbox.maxX ||
            l.bbox.minY < cand.bbox.minY || l.bbox.maxY > cand.bbox.maxY
          ) continue;
          if (!pointInPoly2D(l.centroid, cand.pts)) continue;
          if (!bestParent || cand.areaAbs < bestParent.areaAbs) bestParent = cand;
        }
        parent.set(l.id, bestParent?.id ?? null);
        depth.set(l.id, bestParent ? ((depth.get(bestParent.id) ?? 0) + 1) : 0);
      }
      for (const outer of loops) {
        const d = depth.get(outer.id) ?? 0;
        if (d % 2 !== 0) continue;
        const shape = new THREE.Shape(outer.pts.map((p) => new THREE.Vector2(p.x, p.y)));
        const holes = loops.filter((h) => (parent.get(h.id) === outer.id) && ((depth.get(h.id) ?? 0) === d + 1));
        for (const h of holes) {
          shape.holes.push(new THREE.Path(h.pts.map((p) => new THREE.Vector2(p.x, p.y))));
        }
        const g = new THREE.ShapeGeometry(shape);
        g.applyMatrix4(fillMat);
        fillGeos.push(g);
      }
      if (verts.length > 0 || fillGeos.length > 0) {
        results.push({ id: f.id, name: f.name, positions: new Float32Array(verts), fills: fillGeos });
      }
    }
    return results;
  }, [features, activeSketchId, hiddenGeometryIds]);
  return (
    <>
      {wireframes.map((wf) => (
        <group key={wf.id}>
          {wf.fills.map((geo, i) => (
            <mesh
              key={`${wf.id}_fill_${i}`}
              geometry={geo}
              renderOrder={0}
              onPointerOver={(e) => {
                e.stopPropagation();
                if (allowSketchSelection) setHoveredSketchId(wf.id);
              }}
              onPointerOut={(e) => {
                e.stopPropagation();
                if (allowSketchSelection) setHoveredSketchId((prev) => (prev === wf.id ? null : prev));
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (!allowSketchSelection) return;
                captureGeometricSelection({
                  type: 'sketch',
                  featureId: wf.id,
                  featureName: wf.name,
                  label: `${wf.name} — Sketch`,
                }, !!(e.ctrlKey || e.shiftKey || e.metaKey));
                setSelectedSketchId(wf.id);
              }}
            >
              <meshBasicMaterial
                color={selectedSketchId === wf.id || hoveredSketchId === wf.id ? C_SEL : '#60a5fa'}
                transparent
                opacity={selectedSketchId === wf.id || hoveredSketchId === wf.id ? 0.38 : 0.22}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
          ))}
          <lineSegments
            onPointerOver={(e) => {
              e.stopPropagation();
              if (allowSketchSelection) setHoveredSketchId(wf.id);
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              if (allowSketchSelection) setHoveredSketchId((prev) => (prev === wf.id ? null : prev));
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (!allowSketchSelection) return;
              captureGeometricSelection({
                type: 'sketch',
                featureId: wf.id,
                featureName: wf.name,
                label: `${wf.name} — Sketch`,
              }, !!(e.ctrlKey || e.shiftKey || e.metaKey));
              setSelectedSketchId(wf.id);
            }}
          >
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[wf.positions, 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial
              color={selectedSketchId === wf.id || hoveredSketchId === wf.id ? C_SEL : '#60a5fa'}
            />
          </lineSegments>
        </group>
      ))}
    </>
  );
};

const AXIS_DISPLAY_LEN = 200;

function planeFromRef(ref: GeometricSelectionRef | null): { n: THREE.Vector3; d: number } | null {
  if (!ref) return null;
  if (ref.type === 'defaultPlane') {
    if (ref.name === 'xy') return { n: new THREE.Vector3(0, 0, 1), d: 0 };
    if (ref.name === 'xz') return { n: new THREE.Vector3(0, 1, 0), d: 0 };
    return { n: new THREE.Vector3(1, 0, 0), d: 0 };
  }
  if (ref.type === 'face') {
    const n = new THREE.Vector3(ref.normal[0], ref.normal[1], ref.normal[2]);
    const len = n.length();
    if (len < 1e-9) return null;
    n.divideScalar(len);
    return { n, d: ref.faceOffset };
  }
  return null;
}

const AxisFeatures = () => {
  const features = useCadStore((s) => s.features);
  const hiddenGeometryIds = useCadStore((s) => s.hiddenGeometryIds);

  const axes = useMemo(() => {
    const points = new Map<string, PointFeature>(
      features.filter((f): f is PointFeature => f.type === 'point' && f.enabled !== false).map((f) => [f.id, f]),
    );
    const axisFeatures = features.filter((f): f is AxisFeature => f.type === 'axis' && f.enabled !== false);

    const results: { id: string; a: THREE.Vector3; b: THREE.Vector3 }[] = [];
    for (const af of axisFeatures) {
      const p = af.parameters;
      let origin: THREE.Vector3 | null = null;
      let dir: THREE.Vector3 | null = null;

      if (p.method === 'twoPoints') {
        const p1 = p.point1Id ? points.get(p.point1Id) : undefined;
        const p2 = p.point2Id ? points.get(p.point2Id) : undefined;
        if (!p1 || !p2) continue;
        origin = new THREE.Vector3(p1.parameters.x, p1.parameters.y, p1.parameters.z);
        dir = new THREE.Vector3(
          p2.parameters.x - p1.parameters.x,
          p2.parameters.y - p1.parameters.y,
          p2.parameters.z - p1.parameters.z,
        );
      } else if (p.method === 'planePoint') {
        const pl = planeFromRef(p.planeRef);
        const pt = p.pointId ? points.get(p.pointId) : undefined;
        if (!pl || !pt) continue;
        origin = new THREE.Vector3(pt.parameters.x, pt.parameters.y, pt.parameters.z);
        dir = pl.n.clone();
      } else if (p.method === 'twoPlanes') {
        const pa = planeFromRef(p.planeRefA);
        const pb = planeFromRef(p.planeRefB);
        if (!pa || !pb) continue;
        const n1 = pa.n, n2 = pb.n;
        dir = n1.clone().cross(n2);
        const dirLenSq = dir.lengthSq();
        if (dirLenSq < 1e-10) continue;
        const term1 = n2.clone().cross(dir).multiplyScalar(pa.d);
        const term2 = dir.clone().cross(n1).multiplyScalar(pb.d);
        origin = term1.add(term2).divideScalar(dirLenSq);
      }

      if (!origin || !dir || dir.lengthSq() < 1e-10) continue;
      dir.normalize();
      const half = AXIS_DISPLAY_LEN * 0.5;
      const a = origin.clone().addScaledVector(dir, -half);
      const b = origin.clone().addScaledVector(dir, half);
      if (!hiddenGeometryIds.includes(af.id)) {
        results.push({ id: af.id, a, b });
      }
    }
    return results;
  }, [features, hiddenGeometryIds]);

  return (
    <>
      {axes.map((ax) => (
        <Line key={ax.id} points={[ax.a, ax.b]} color="#fbbf24" lineWidth={2} />
      ))}
    </>
  );
};

const PointFeatures = () => {
  const { features, hiddenGeometryIds, activeInputField, captureGeometricSelection, setLastGeometricSelection, selectionResetToken } =
    useCadStore();
  const inSelMode = !!activeInputField;
  const selectionKind = selectionKindFromField(activeInputField);
  const allowPointSelection = !inSelMode || selectionKind === 'any' || selectionKind === 'point';
  const points = useMemo(
    () => features.filter((f): f is PointFeature => f.type === 'point' && f.enabled !== false && !hiddenGeometryIds.includes(f.id)),
    [features, hiddenGeometryIds]
  );
  const [hoveredPointId, setHoveredPointId] = useState<string | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);

  useEffect(() => {
    setHoveredPointId(null);
    setSelectedPointId(null);
  }, [selectionResetToken]);

  return (
    <>
      {points.map((pf) => {
        const isHovered = hoveredPointId === pf.id;
        const isSelected = selectedPointId === pf.id;
        const color = isSelected ? C_SEL : isHovered ? (inSelMode ? C_SEL : C_FACE_HOV) : '#eab308';
        return (
          <mesh
            key={pf.id}
            position={[pf.parameters.x, pf.parameters.y, pf.parameters.z]}
            onPointerOver={(e) => {
              e.stopPropagation();
              if (allowPointSelection) setHoveredPointId(pf.id);
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              if (allowPointSelection) setHoveredPointId((prev) => (prev === pf.id ? null : prev));
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (!allowPointSelection) return;
              const ref: GeometricSelectionRef = {
                type: 'point',
                featureId: pf.id,
                featureName: pf.name,
                position: [pf.parameters.x, pf.parameters.y, pf.parameters.z],
                label: `${pf.name} — Point`,
              };
              if (inSelMode) {
                captureGeometricSelection(ref, !!(e.ctrlKey || e.shiftKey || e.metaKey));
              } else {
                setLastGeometricSelection(ref);
                setSelectedPointId((prev) => (prev === pf.id ? null : pf.id));
              }
            }}
          >
            <sphereGeometry args={[isHovered || isSelected ? 0.35 : 0.25, 24, 24]} />
            <meshStandardMaterial color={color} emissive={isHovered || isSelected ? '#78350f' : '#000000'} emissiveIntensity={0.15} />
          </mesh>
        );
      })}
    </>
  );
};

const USER_PLANE_VIS_SIZE = 20;

/** User-defined construction planes (offset / three points) — same role as AxisFeatures / PointFeatures. */
const PlaneFeatures = () => {
  const features = useCadStore((s) => s.features);
  const hiddenGeometryIds = useCadStore((s) => s.hiddenGeometryIds);

  const items = useMemo(() => {
    const pointById = new Map<string, PointFeature>(
      features.filter((f): f is PointFeature => f.type === 'point' && f.enabled !== false).map((f) => [f.id, f]),
    );
    const out: { id: string; position: THREE.Vector3; quaternion: THREE.Quaternion }[] = [];

    for (const f of features) {
      if (f.type !== 'plane' || f.enabled === false) continue;
      if (hiddenGeometryIds.includes(f.id)) continue;

      const p = (f as PlaneFeature).parameters;
      let pos: THREE.Vector3;
      let quat: THREE.Quaternion;

      if (p.method === 'offset') {
        const ref = p.reference;
        if (!ref) continue;
        const pl = planeFromRef(ref);
        if (!pl) continue;
        const off = Number(p.offset) || 0;
        const d = pl.d + off;
        const n = pl.n.clone().normalize();
        pos = n.clone().multiplyScalar(d);
        quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      } else if (p.method === 'threePoints') {
        const id1 = p.point1Id;
        const id2 = p.point2Id;
        const id3 = p.point3Id;
        if (!id1 || !id2 || !id3) continue;
        const t1 = pointById.get(id1);
        const t2 = pointById.get(id2);
        const t3 = pointById.get(id3);
        if (!t1 || !t2 || !t3) continue;
        const p1 = new THREE.Vector3(t1.parameters.x, t1.parameters.y, t1.parameters.z);
        const p2 = new THREE.Vector3(t2.parameters.x, t2.parameters.y, t2.parameters.z);
        const p3 = new THREE.Vector3(t3.parameters.x, t3.parameters.y, t3.parameters.z);
        const e1 = p2.clone().sub(p1);
        const e2 = p3.clone().sub(p1);
        const n = e1.cross(e2);
        if (n.lengthSq() < 1e-14) continue;
        n.normalize();
        pos = p1.clone().add(p2).add(p3).multiplyScalar(1 / 3);
        quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      } else {
        continue;
      }

      out.push({ id: f.id, position: pos, quaternion: quat });
    }
    return out;
  }, [features, hiddenGeometryIds]);

  return (
    <>
      {items.map((it) => (
        <mesh key={it.id} position={it.position} quaternion={it.quaternion}>
          <planeGeometry args={[USER_PLANE_VIS_SIZE, USER_PLANE_VIS_SIZE]} />
          <meshBasicMaterial
            color="#a855f7"
            transparent
            opacity={0.2}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
    </>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Default Reference Planes + intersection axis lines
// ──────────────────────────────────────────────────────────────────────────────
const PLANE_CFG: { name: 'xy' | 'xz' | 'yz'; color: string; rot: [number, number, number] }[] = [
  { name: 'xy', color: '#3b82f6', rot: [0, 0, 0] },
  { name: 'xz', color: '#ef4444', rot: [Math.PI / 2, 0, 0] },
  { name: 'yz', color: '#22c55e', rot: [0, Math.PI / 2, 0] },
];

const PLANE_SIZE = 20;
const AXIS_LEN   = PLANE_SIZE / 2;

// X axis = intersection of XY and XZ  (red)
// Y axis = intersection of XY and YZ  (green)
// Z axis = intersection of XZ and YZ  (blue)
const AXIS_LINES = [
  { points: [new THREE.Vector3(-AXIS_LEN, 0, 0), new THREE.Vector3(AXIS_LEN, 0, 0)], color: '#ef4444' },
  { points: [new THREE.Vector3(0, -AXIS_LEN, 0), new THREE.Vector3(0, AXIS_LEN, 0)], color: '#22c55e' },
  { points: [new THREE.Vector3(0, 0, -AXIS_LEN), new THREE.Vector3(0, 0, AXIS_LEN)], color: '#3b82f6' },
];

const DefaultPlanes = () => {
  const { selectedPlane, setSelectedPlane, activeInputField, captureGeometricSelection, showOriginPlanes, hiddenGeometryIds } =
    useCadStore();
  const [hovPlane, setHovPlane] = useState<string | null>(null);
  const { scene } = useThree();
  const inSelMode = !!activeInputField;
  const selectionKind = selectionKindFromField(activeInputField);
  const allowPlaneSelection = !inSelMode || selectionKind === 'any' || selectionKind === 'planeFace';
  const sketchPlanePickMode = activeInputField === 'sketchPlane' || activeInputField === 'sketchPlaneEdit';
  const selectFaceIfHit = useCallback(
    (e: any) => {
      const hits = e?.raycaster?.intersectObjects(scene.children, true) ?? [];
      if (!hits.length) return false;
      const faceHit = hits.find((hit: any) => hit?.object?.userData?.pickType === 'brepFace');
      if (!faceHit) return false;
      const pick = faceHit.object.userData as FacePickData;
      if (!pick?.face) return false;
      const ref = buildFaceSelectionRef(pick.face, pick.featureId, pick.featureName, faceHit.point?.clone?.());
      captureGeometricSelection(ref, !!(e.ctrlKey || e.shiftKey || e.metaKey));
      return true;
    },
    [captureGeometricSelection, scene],
  );

  // Respect the global plane visibility toggle in all modes.
  const showPlanes = showOriginPlanes;

  return (
    <group>
      {/* Intersection axis lines — shown whenever planes are visible */}
      {showPlanes && AXIS_LINES.map((ax, i) => (
        <Line
          key={i}
          points={ax.points}
          color={ax.color}
          lineWidth={1.2}
          transparent
          opacity={0.6}
          depthWrite={false}
          renderOrder={1}
        />
      ))}

      {/* Plane quads */}
      {PLANE_CFG.map(({ name, color, rot }) => (
        (() => {
          const planeId = `origin-${name}`;
          const planeVisible = inSelMode || (!hiddenGeometryIds.includes(planeId) && showPlanes);
          return (
        <mesh
          key={name}
          rotation={rot as any}
          visible={planeVisible}
          raycast={sketchPlanePickMode ? () => null : undefined}
          onPointerDown={(e) => {
            if (sketchPlanePickMode) return;
            if (inSelMode && allowPlaneSelection && selectFaceIfHit(e)) {
              e.stopPropagation();
              return;
            }
            e.stopPropagation();
            if (inSelMode) {
              if (!allowPlaneSelection) return;
              captureGeometricSelection({
                type: 'defaultPlane',
                name,
                label: `${name.toUpperCase()} Plane`,
              }, !!(e.ctrlKey || e.shiftKey || e.metaKey));
              return;
            }
            setSelectedPlane(name);
          }}
          onPointerOver={() => { if (allowPlaneSelection) setHovPlane(name); }}
          onPointerOut={() => { if (allowPlaneSelection) setHovPlane(null); }}
        >
          <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
          <meshBasicMaterial
            color={selectedPlane === name || (inSelMode && allowPlaneSelection && hovPlane === name) ? '#f59e0b' : color}
            transparent
            opacity={inSelMode && allowPlaneSelection && hovPlane === name ? 0.4 : 0.12}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
          );
        })()
      ))}
    </group>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Selection hint overlay
// ──────────────────────────────────────────────────────────────────────────────
const SelectionHint = () => {
  const { activeInputField, activeCommand, selectedFeatureId, features, deactivateGeometricInput } = useCadStore();
  if (!activeInputField) return null;
  const selectedFeature = features.find((f) => f.id === selectedFeatureId);
  const objectLabel = selectionKindFromField(activeInputField) === 'edge'
    ? 'edge'
    : selectionKindFromField(activeInputField) === 'planeFace'
    ? 'plane or face'
    : selectionKindFromField(activeInputField) === 'point'
    ? 'point'
    : selectionKindFromField(activeInputField) === 'sketch'
    ? 'sketch'
    : 'object';
  const operationRaw = activeCommand ?? selectedFeature?.type ?? 'operation';
  const operationLabel = operationRaw.charAt(0).toUpperCase() + operationRaw.slice(1);
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-amber-300 text-zinc-900 text-xs font-semibold px-4 py-2 rounded-full shadow-lg flex items-center gap-2 pointer-events-auto">
      <span>
        Select <strong>{objectLabel}</strong> for {operationLabel}
      </span>
      <span className="mx-1">—</span>
      <button onClick={deactivateGeometricInput} className="underline hover:no-underline">
        Cancel
      </button>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Camera view controller — listens to pendingCameraView and moves the camera
// ──────────────────────────────────────────────────────────────────────────────
const CAMERA_DIST = 40;
const VIEW_POSITIONS: Record<string, [number, number, number]> = {
  front:     [0, 0, CAMERA_DIST],
  back:      [0, 0, -CAMERA_DIST],
  left:      [-CAMERA_DIST, 0, 0],
  right:     [CAMERA_DIST, 0, 0],
  top:       [0, CAMERA_DIST, 0.001],
  bottom:    [0, -CAMERA_DIST, 0.001],
  isometric: [CAMERA_DIST * 0.7, CAMERA_DIST * 0.7, CAMERA_DIST * 0.7],
};

const CameraController = () => {
  const pendingView = useCadStore((s) => s.pendingCameraView);
  const clearView = useCadStore((s) => s.clearPendingCameraView);
  const perspective = useCadStore((s) => s.perspective);
  const { camera, set: setThree, size } = useThree();
  const controlsRef = useRef<any>(null);
  const orthoFrustumRef = useRef<number>(20);

  useEffect(() => {
    const pos = camera.position.clone();
    const target = controlsRef.current?.target.clone() ?? new THREE.Vector3();
    if (perspective) {
      const cam = new THREE.PerspectiveCamera(45, size.width / size.height, 0.1, 2000);
      cam.position.copy(pos);
      cam.lookAt(target);
      cam.zoom = (camera as any).zoom ?? 1;
      cam.updateProjectionMatrix();
      setThree({ camera: cam as any });
    } else {
      const frustum = Math.max(pos.distanceTo(target) * 0.5, 0.001);
      orthoFrustumRef.current = frustum;
      const aspect = size.width / size.height;
      const cam = new THREE.OrthographicCamera(-frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 2000);
      cam.position.copy(pos);
      cam.lookAt(target);
      cam.zoom = (camera as any).zoom ?? 1;
      cam.updateProjectionMatrix();
      setThree({ camera: cam as any });
    }
  }, [perspective]);

  useEffect(() => {
    // Keep current zoom level while adapting projection to viewport resize.
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
      return;
    }
    if (camera instanceof THREE.OrthographicCamera) {
      const frustum = Math.max(orthoFrustumRef.current, 0.001);
      const aspect = size.width / size.height;
      camera.left = -frustum * aspect;
      camera.right = frustum * aspect;
      camera.top = frustum;
      camera.bottom = -frustum;
      camera.updateProjectionMatrix();
    }
  }, [size.width, size.height, camera]);

  useEffect(() => {
    if (!pendingView) return;
    const target = VIEW_POSITIONS[pendingView];
    if (!target) { clearView(); return; }
    const [x, y, z] = target;
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();
    clearView();
  }, [pendingView, clearView, camera]);

  return <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />;
};

// ──────────────────────────────────────────────────────────────────────────────
// Floor grid (only when showGrid is true)
// ──────────────────────────────────────────────────────────────────────────────
const FloorGrid = () => {
  const showGrid = useCadStore((s) => s.showGrid);
  if (!showGrid) return null;
  return (
    <Grid
      args={[100, 100]}
      cellSize={1}
      cellThickness={0.8}
      cellColor="#9ca3af"
      sectionSize={10}
      sectionThickness={1.5}
      sectionColor="#6b7280"
      fadeDistance={60}
      fadeStrength={1}
    />
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Viewport
// ──────────────────────────────────────────────────────────────────────────────
export const Viewport3D = () => {
  const setSelectedPlane = useCadStore((s) => s.setSelectedPlane);
  const activeInputField = useCadStore((s) => s.activeInputField);
  const captureGeometricSelection = useCadStore((s) => s.captureGeometricSelection);
  const deactivateGeometricInput = useCadStore((s) => s.deactivateGeometricInput);
  const setLastGeometricSelection = useCadStore((s) => s.setLastGeometricSelection);
  const triggerSelectionReset = useCadStore((s) => s.triggerSelectionReset);

  const clearSelection = useCallback(() => {
    setSelectedPlane(null);
    setLastGeometricSelection(null);
    triggerSelectionReset();
  }, [setSelectedPlane, setLastGeometricSelection, triggerSelectionReset]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      deactivateGeometricInput();
      clearSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deactivateGeometricInput, clearSelection]);

  return (
    <div className="w-full h-full relative">
      <SelectionHint />
      <Canvas
        camera={{ position: [30, 30, 30], fov: 45 }}
        onPointerDown={(e: ThreeEvent<PointerEvent>) => {
          const sketchPlanePickMode = activeInputField === 'sketchPlane' || activeInputField === 'sketchPlaneEdit';
          if (!sketchPlanePickMode) return;
          const faceHit = e.intersections.find((hit: any) => hit?.object?.userData?.pickType === 'brepFace');
          if (!faceHit) return;
          const pick = faceHit.object.userData as FacePickData;
          if (!pick?.face) return;
          const ref = buildFaceSelectionRef(pick.face, pick.featureId, pick.featureName, faceHit.point?.clone?.());
          captureGeometricSelection(ref, !!(e.ctrlKey || e.shiftKey || e.metaKey));
          e.stopPropagation();
        }}
        onPointerMissed={() => {
          if (activeInputField) {
            deactivateGeometricInput();
          } else {
            clearSelection();
          }
        }}
      >
        <color attach="background" args={['#f1f5f9']} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[15, 25, 15]} intensity={1.2} castShadow />
        <directionalLight position={[-10, -15, -10]} intensity={0.25} />
        <DefaultPlanes />
        <SketchWireframes />
        <AxisFeatures />
        <PointFeatures />
        <PlaneFeatures />
        <CADSolids />
        <FloorGrid />
        <CameraController />
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#111827" />
        </GizmoHelper>
      </Canvas>
    </div>
  );
};
