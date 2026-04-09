import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport, Grid, Line } from '@react-three/drei';
import {
  useCadStore,
  type Feature,
  type GeometricSelectionRef,
  type SketchFeature,
  type SketchData,
  type AxisFeature,
  type PlaneFeature,
  type PointFeature,
} from '../store/useCadStore';
import * as THREE from 'three';
import {
  initCAD,
  isCADReady,
  buildAllSolids,
  buildPreviewDifferenceSolids,
  type SolidMeshData,
} from '../lib/cadEngine';
import { featuresToCadFeatureInputs } from '../lib/cadFeatureInputs';
import {
  getSketchPlaneBasis,
  sketch2DToWorld,
  planeEquationFromRef,
  planeEquationFromPlaneFeature,
  worldPositionFromPlanePointSlot,
  worldPositionFromAxisTwoPointSlot,
} from '../lib/sketchPlaneBasis';
import { arcSignedSweep, sampleArcPoints } from '../lib/sketchArcPoints';
import {
  BSPLINE_DEFAULT_DEGREE,
  BSPLINE_DEFAULT_SAMPLES_PER_SPAN,
  sampleOpenUniformBSpline,
} from '../lib/sketchBspline';
import { mergeCoincidentSketchVertices, pickNextEdgeInFace, snapClosedPolyline } from '../lib/sketchLoopDetection';
import {
  usePartViewportMode,
  type PartViewportGeometryKind,
  type PartViewportMode,
} from '../viewport/partViewportMode';

const C_BASE     = '#bfdbfe';
const C_FACE_HOV = '#93c5fd';
const C_SEL      = '#f59e0b';
const C_EDGE     = '#334155';
const C_EDGE_HOV = '#38bdf8';

/** 3D sketch overlay: filled regions + wire (stronger than legacy 0.22 / #60a5fa) */
const C_SKETCH_VIEW_FILL = '#2563eb';
const C_SKETCH_VIEW_FILL_OP = 0.25;
const C_SKETCH_VIEW_FILL_SEL_OP = 0.50;
const C_SKETCH_VIEW_LINE = '#1e40af';

/** Max midpoint distance (model units) between stored ref and mesh edge — allows tessellation drift */
const EDGE_PREFETCH_MID_MAX = 0.04;
/** Direction vectors must be parallel (same line), |dot| ≥ this */
const EDGE_PREFETCH_DIR_DOT_MIN = 0.98;

/** Whether a mesh edge is a plausible match for a stored edge ref (parallel + same feature). */
function edgeRefCouldMatchMeshEdge(
  ref: Extract<GeometricSelectionRef, { type: 'edge' }>,
  solidFeatureId: string,
  edge: BRepEdge,
): boolean {
  if (ref.featureId !== solidFeatureId) return false;
  const rdx = ref.direction[0];
  const rdy = ref.direction[1];
  const rdz = ref.direction[2];
  const rlen = Math.hypot(rdx, rdy, rdz);
  const edx = edge.dir[0];
  const edy = edge.dir[1];
  const edz = edge.dir[2];
  const elen = Math.hypot(edx, edy, edz);
  if (rlen < 1e-12 || elen < 1e-12) return false;
  const dot = Math.abs((rdx * edx + rdy * edy + rdz * edz) / (rlen * elen));
  if (dot < EDGE_PREFETCH_DIR_DOT_MIN) return false;
  return true;
}

function midpointDistSqToEdge(
  ref: Extract<GeometricSelectionRef, { type: 'edge' }>,
  edge: BRepEdge,
): number {
  const dx = ref.midpoint[0] - edge.mid[0];
  const dy = ref.midpoint[1] - edge.mid[1];
  const dz = ref.midpoint[2] - edge.mid[2];
  return dx * dx + dy * dy + dz * dz;
}

/** One stored ref → at most one mesh edge id (closest midpoint among direction/bbox candidates). */
function bestMeshEdgeIdForRef(
  ref: Extract<GeometricSelectionRef, { type: 'edge' }>,
  solidFeatureId: string,
  edges: BRepEdge[],
): number | null {
  let bestId: number | null = null;
  let bestDistSq = Infinity;
  const maxSq = EDGE_PREFETCH_MID_MAX * EDGE_PREFETCH_MID_MAX;
  for (const edge of edges) {
    if (!edgeRefCouldMatchMeshEdge(ref, solidFeatureId, edge)) continue;
    const dsq = midpointDistSqToEdge(ref, edge);
    if (dsq < bestDistSq && dsq <= maxSq) {
      bestDistSq = dsq;
      bestId = edge.id;
    }
  }
  return bestId;
}

function faceRefMatchesMeshFace(
  ref: Extract<GeometricSelectionRef, { type: 'face' }>,
  solidFeatureId: string,
  face: BRepFace,
): boolean {
  if (ref.featureId !== solidFeatureId) return false;
  const fn = face.normal.clone().normalize();
  const rn = new THREE.Vector3(ref.normal[0], ref.normal[1], ref.normal[2]).normalize();
  if (Math.abs(fn.dot(rn)) < 0.995) return false;
  const pos = face.geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  if (!n) return false;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i);
  }
  cx /= n; cy /= n; cz /= n;
  const dist = rn.x * cx + rn.y * cy + rn.z * cz;
  return Math.abs(dist - ref.faceOffset) < 0.02;
}

function selectionHintObjectLabel(mode: PartViewportMode): string {
  if (mode.type !== 'selection') return 'object';
  const a = new Set(mode.allowed);
  const all: PartViewportGeometryKind[] = ['sketch', 'face', 'edge', 'point', 'defaultPlane', 'plane', 'worldAxis', 'axisFeature'];
  if (a.size >= all.length) return 'object';
  if (a.has('edge') && a.has('worldAxis') && a.has('axisFeature') && a.size === 3) {
    return 'axis (origin, edge, or axis feature)';
  }
  if (a.has('edge') && a.size === 1) return 'edge';
  if (a.has('sketch') && a.size === 1) return 'sketch';
  if (a.has('point') && a.size === 1) return 'point';
  if (a.has('face') && a.has('defaultPlane') && a.has('plane') && a.size === 3) return 'plane or face';
  if (a.has('face') && a.has('defaultPlane') && a.size === 2) return 'plane or face';
  return 'object';
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

/**
 * Translucent origin / construction planes use depthWrite=false and sit at the origin, so the ray
 * often hits them before a parallel solid face. Intersections are distance-sorted; return the nearest
 * B-rep face along the ray when the user is allowed to pick faces (e.g. sketch plane).
 */
function tryBrepFaceSelectionRefFromIntersections(
  intersections: THREE.Intersection[],
): GeometricSelectionRef | null {
  for (const hit of intersections) {
    const ud = hit.object.userData as Partial<FacePickData> | undefined;
    if (ud?.pickType === 'brepFace' && ud.face && ud.featureId && ud.featureName) {
      return buildFaceSelectionRef(ud.face, ud.featureId, ud.featureName, hit.point);
    }
  }
  return null;
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
// B-Rep vertices — deduped edge endpoints for body point picking
// ──────────────────────────────────────────────────────────────────────────────
interface BRepMeshVertex {
  id: number;
  position: THREE.Vector3;
}

const VERTEX_MATCH_TOL_SQ = 0.04 * 0.04;

function buildVerticesFromEdges(edges: BRepEdge[]): BRepMeshVertex[] {
  const tol = 1e-3;
  const merged: THREE.Vector3[] = [];
  for (const e of edges) {
    if (e.points.length < 2) continue;
    for (const cand of [e.points[0], e.points[e.points.length - 1]]) {
      let dup = false;
      for (const m of merged) {
        if (m.distanceTo(cand) < tol) {
          dup = true;
          break;
        }
      }
      if (!dup) merged.push(cand.clone());
    }
  }
  return merged.map((position, id) => ({ id, position }));
}

function bestMeshVertexIdForPointRef(
  ref: Extract<GeometricSelectionRef, { type: 'point' }>,
  solidFeatureId: string,
  vertices: BRepMeshVertex[],
): number | null {
  if (ref.featureId !== solidFeatureId) return null;
  let bestId: number | null = null;
  let bestD = Infinity;
  for (const v of vertices) {
    const dx = ref.position[0] - v.position.x;
    const dy = ref.position[1] - v.position.y;
    const dz = ref.position[2] - v.position.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD && d <= VERTEX_MATCH_TOL_SQ) {
      bestD = d;
      bestId = v.id;
    }
  }
  return bestId;
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

interface SolidVertexHandleProps {
  position: THREE.Vector3;
  hovered: boolean;
  selected: boolean;
  inSelMode: boolean;
  selectable: boolean;
  preview?: boolean;
  previewColor?: string;
  ghost?: boolean;
  faded?: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onSelect: (ctrlKey: boolean) => void;
}

const SolidVertexHandle: React.FC<SolidVertexHandleProps> = ({
  position,
  hovered,
  selected,
  inSelMode,
  selectable,
  preview,
  previewColor,
  ghost = false,
  faded = false,
  onEnter,
  onLeave,
  onSelect,
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
  const rVis = effectiveHover || selected ? 0.16 : 0.12;
  const rPick = 0.42;
  return (
    <group position={position}>
      <mesh
        renderOrder={1}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (selectable) onEnter();
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          if (selectable) onLeave();
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (selectable) onSelect(!!(e.ctrlKey || e.shiftKey || e.metaKey));
        }}
      >
        <sphereGeometry args={[rPick, 16, 16]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh renderOrder={2}>
        <sphereGeometry args={[rVis, 20, 20]} />
        <meshStandardMaterial
          color={color}
          transparent={preview || faded}
          opacity={preview ? 0.75 : faded ? 0.5 : 1}
          emissive={effectiveHover || selected ? (ghost ? '#475569' : '#1e293b') : '#000000'}
          emissiveIntensity={effectiveHover || selected ? 0.2 : 0}
        />
      </mesh>
    </group>
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
      userData={selectable ? ({ pickType: 'brepFace', face, featureId, featureName } satisfies FacePickData) : {}}
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
  partViewportMode: PartViewportMode;
}

const SolidMesh: React.FC<SolidMeshProps> = ({
  solidData,
  selectable = true,
  preview = false,
  previewColor,
  ghost = false,
  faded = false,
  partViewportMode,
}) => {
  const { captureGeometricSelection, selectionResetToken, activeInputOptions } = useCadStore();
  const inSelectionMode = partViewportMode.type === 'selection';
  const allowed = partViewportMode.type === 'selection' ? partViewportMode.allowed : [];
  const allowFaceSelection = selectable && inSelectionMode && allowed.includes('face');
  const allowEdgeSelection = selectable && inSelectionMode && allowed.includes('edge');
  /** Default on for point-only picking; set `allowSolidVertices: false` in options to hide */
  const allowSolidVertexPick =
    selectable &&
    inSelectionMode &&
    allowed.includes('point') &&
    activeInputOptions != null &&
    activeInputOptions.allowSolidVertices !== false;
  const selectionAccentHover = inSelectionMode;

  const faces = useMemo(() => buildFacesFromMesh(solidData), [solidData]);
  const edges = useMemo(() => buildEdgesFromMesh(solidData), [solidData]);
  const meshVertices = useMemo(() => buildVerticesFromEdges(edges), [edges]);

  const preselectedRefs = activeInputOptions?.preselected;
  const preselectedEdgeIds = useMemo(() => {
    const ids = new Set<number>();
    if (!preselectedRefs || !allowEdgeSelection) return ids;
    for (const r of preselectedRefs) {
      if (r.type !== 'edge') continue;
      const id = bestMeshEdgeIdForRef(r, solidData.featureId, edges);
      if (id !== null) ids.add(id);
    }
    return ids;
  }, [preselectedRefs, edges, allowEdgeSelection, solidData.featureId]);

  const preselectedFaceGroupIds = useMemo(() => {
    const ids = new Set<number>();
    if (!preselectedRefs || !allowFaceSelection) return ids;
    for (const face of faces) {
      for (const r of preselectedRefs) {
        if (r.type === 'face' && faceRefMatchesMeshFace(r, solidData.featureId, face)) ids.add(face.groupId);
      }
    }
    return ids;
  }, [preselectedRefs, faces, allowFaceSelection, solidData.featureId]);

  const preselectedVertexIds = useMemo(() => {
    const ids = new Set<number>();
    if (!preselectedRefs || !allowSolidVertexPick) return ids;
    for (const r of preselectedRefs) {
      if (r.type !== 'point') continue;
      const id = bestMeshVertexIdForPointRef(r, solidData.featureId, meshVertices);
      if (id !== null) ids.add(id);
    }
    return ids;
  }, [preselectedRefs, meshVertices, allowSolidVertexPick, solidData.featureId]);

  const [selFaceId, setSelFaceId] = useState<number | null>(null);
  const [hovEdge, setHovEdge] = useState<number | null>(null);
  const [selEdge, setSelEdge] = useState<number | null>(null);
  const [hovVertexId, setHovVertexId] = useState<number | null>(null);
  const [selVertexId, setSelVertexId] = useState<number | null>(null);

  useEffect(() => {
    setSelFaceId(null);
    setSelEdge(null);
    setHovEdge(null);
    setSelVertexId(null);
    setHovVertexId(null);
  }, [selectionResetToken]);

  const handleFaceSelect = useCallback(
    (face: BRepFace, hitPoint?: THREE.Vector3, ctrlKey = false) => {
      const ref = buildFaceSelectionRef(face, solidData.featureId, solidData.featureName, hitPoint);
      console.log('[CAD][FaceSelect]', {
        featureId: solidData.featureId,
        featureName: solidData.featureName,
        inSelectionMode,
        ref,
      });
      if (inSelectionMode) {
        captureGeometricSelection(ref, ctrlKey);
        setSelFaceId(face.groupId);
        setSelEdge(null);
        setSelVertexId(null);
      }
    },
    [inSelectionMode, solidData.featureId, solidData.featureName, captureGeometricSelection],
  );

  const makeEdgeHandlers = useCallback(
    (edge: BRepEdge) => ({
      onEnter: () => setHovEdge(edge.id),
      onLeave: () => setHovEdge(null),
      onSelect: (ctrlKey: boolean) => {
        if (!inSelectionMode) return;
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
        setSelEdge(edge.id);
        setSelFaceId(null);
        setSelVertexId(null);
      },
    }),
    [inSelectionMode, solidData.featureId, solidData.featureName, captureGeometricSelection],
  );

  const makeVertexHandlers = useCallback(
    (v: BRepMeshVertex) => ({
      onEnter: () => setHovVertexId(v.id),
      onLeave: () => setHovVertexId(null),
      onSelect: (ctrlKey: boolean) => {
        if (!inSelectionMode || !allowSolidVertexPick) return;
        const pos = v.position;
        captureGeometricSelection(
          {
            type: 'point',
            featureId: solidData.featureId,
            featureName: solidData.featureName,
            position: [pos.x, pos.y, pos.z],
            label: `${solidData.featureName} — Vertex`,
          },
          ctrlKey,
        );
        setSelVertexId(v.id);
        setSelFaceId(null);
        setSelEdge(null);
      },
    }),
    [inSelectionMode, allowSolidVertexPick, solidData.featureId, solidData.featureName, captureGeometricSelection],
  );

  return (
    <group>
      {faces.map((face) => (
        <FaceMesh
          key={`f${face.groupId}`}
          face={face}
          featureId={solidData.featureId}
          featureName={solidData.featureName}
          selected={selFaceId === face.groupId || preselectedFaceGroupIds.has(face.groupId)}
          inSelMode={selectionAccentHover}
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
          selected={selEdge === edge.id || preselectedEdgeIds.has(edge.id)}
          inSelMode={selectionAccentHover}
          selectable={allowEdgeSelection}
          preview={preview}
          previewColor={previewColor}
          ghost={ghost}
          faded={faded}
          {...makeEdgeHandlers(edge)}
        />
      ))}
      {allowSolidVertexPick &&
        meshVertices.map((v) => (
          <SolidVertexHandle
            key={`v${v.id}`}
            position={v.position}
            hovered={hovVertexId === v.id}
            selected={selVertexId === v.id || preselectedVertexIds.has(v.id)}
            inSelMode={selectionAccentHover}
            selectable={allowSolidVertexPick}
            preview={preview}
            previewColor={previewColor}
            ghost={ghost}
            faded={faded}
            {...makeVertexHandlers(v)}
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
  const activeInputField = useCadStore((s) => s.activeInputField);
  const activeInputOptions = useCadStore((s) => s.activeInputOptions);
  const partViewportMode = usePartViewportMode();
  const [cadReady, setCadReady] = useState(isCADReady());
  const [solids, setSolids] = useState<SolidMeshData[]>([]);
  const [beforeSolids, setBeforeSolids] = useState<SolidMeshData[]>([]);
  const [previewSolids, setPreviewSolids] = useState<SolidMeshData[]>([]);
  const [previewColor, setPreviewColor] = useState<string>('#86efac');

  const toFeatureInputs = useCallback((sourceFeatures: typeof features) => featuresToCadFeatureInputs(sourceFeatures), []);

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
        ['extrude', 'cut', 'revolve', 'revolveCut', 'fillet', 'chamfer'].includes(selectedFeature.type);
      const canPreviewCreate =
        !selectedFeature &&
        !!activeCommand &&
        ['extrude', 'cut', 'revolve', 'revolveCut', 'fillet', 'chamfer'].includes(activeCommand) &&
        !!transientPreviewFeature;
      if (editableSolidFeature && selectedFeature) {
        const opType = selectedFeature.type;
        setPreviewColor(['cut', 'revolveCut', 'fillet', 'chamfer'].includes(opType) ? '#f87171' : '#86efac');
        const beforeInputs = toFeatureInputs(features.slice(0, selectedIndex));
        const before = buildAllSolids(beforeInputs);
        const afterInputs = toFeatureInputs(features.slice(0, selectedIndex + 1));
        const preview = buildPreviewDifferenceSolids(beforeInputs, afterInputs);
        setBeforeSolids(before);
        setPreviewSolids(preview);
      } else if (canPreviewCreate && transientPreviewFeature) {
        setPreviewColor(['cut', 'revolveCut', 'fillet', 'chamfer'].includes(activeCommand ?? '') ? '#f87171' : '#86efac');
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

  /** Ghost before/preview is for visualizing the edit; it replaces full solids and is not pickable. */
  const showFeatureEditGhost =
    (beforeSolids.length > 0 || previewSolids.length > 0) && activeInputField == null;

  /** While picking (e.g. chamfer edges when editing), use the before-feature solid so edge refs match the target body. */
  const pickFromBeforeFeature = !!activeInputOptions?.pickFromBeforeFeature;
  const showBeforeSolidsForSelection =
    !!activeInputField && pickFromBeforeFeature && beforeSolids.length > 0;

  return (
    <>
      {showFeatureEditGhost ? (
        <>
          {beforeSolids.map((sd, i) => (
            hiddenGeometryIds.includes(`${sd.featureId}:${i}`)
              ? null
              : (
                <SolidMesh
                  key={`before_${sd.featureId}_${i}`}
                  solidData={sd}
                  selectable={false}
                  ghost
                  partViewportMode={partViewportMode}
                />
              )
          ))}
          {previewSolids.map((sd, i) => (
            <SolidMesh
              key={`preview_${sd.featureId}_${i}`}
              solidData={sd}
              selectable={false}
              preview
              previewColor={previewColor}
              partViewportMode={partViewportMode}
            />
          ))}
        </>
      ) : showBeforeSolidsForSelection ? (
        beforeSolids.map((sd, i) => (
          hiddenGeometryIds.includes(`${sd.featureId}:${i}`)
            ? null
            : (
              <SolidMesh
                key={`before_sel_${sd.featureId}_${i}`}
                solidData={sd}
                selectable
                partViewportMode={partViewportMode}
              />
            )
        ))
      ) : (
        solids.map((sd, i) => (
          hiddenGeometryIds.includes(`${sd.featureId}:${i}`)
            ? null
            : (
              <SolidMesh
                key={`${sd.featureId}_${i}`}
                solidData={sd}
                selectable
                partViewportMode={partViewportMode}
              />
            )
        ))
      )}
    </>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Sketch Wireframes
// ──────────────────────────────────────────────────────────────────────────────
const SketchWireframes = () => {
  const { features, captureGeometricSelection, selectionResetToken, activeInputOptions } = useCadStore();
  const activeSketchId = useCadStore((s) => s.activeSketchId);
  const hiddenGeometryIds = useCadStore((s) => s.hiddenGeometryIds);
  const partViewportMode = usePartViewportMode();
  const allowSketchSelection =
    partViewportMode.type === 'selection' && partViewportMode.allowed.includes('sketch');
  const [hoveredSketchId, setHoveredSketchId] = useState<string | null>(null);
  const [selectedSketchId, setSelectedSketchId] = useState<string | null>(null);
  useEffect(() => {
    setHoveredSketchId(null);
    setSelectedSketchId(null);
  }, [selectionResetToken]);
  useEffect(() => {
    if (!allowSketchSelection) return;
    const pre = activeInputOptions?.preselected;
    const sk = pre?.find((r): r is Extract<GeometricSelectionRef, { type: 'sketch' }> => r.type === 'sketch');
    if (sk) setSelectedSketchId(sk.featureId);
  }, [allowSketchSelection, activeInputOptions?.preselected]);
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
      for (const arc of (sd.arcs ?? []) as SketchData['arcs']) {
        const c = ptMap.get(arc.centerId);
        const s = ptMap.get(arc.startId);
        const e = ptMap.get(arc.endId);
        if (!c || !s || !e) continue;
        const r = Math.hypot(s.x - c.x, s.y - c.y);
        if (r < 1e-8) continue;
        const a0 = Math.atan2(s.y - c.y, s.x - c.x);
        const a1 = Math.atan2(e.y - c.y, e.x - c.x);
        const sweep = arcSignedSweep(a0, a1, !!arc.complementaryArc);
        const sweepAbs = Math.abs(sweep);
        const segs = Math.max(8, Math.ceil(sweepAbs / (Math.PI / 24)));
        for (let i = 0; i < segs; i++) {
          const t1 = i / segs, t2 = (i + 1) / segs;
          const aa = a0 + sweep * t1;
          const bb = a0 + sweep * t2;
          const [x1, y1, z1] = sketch2DToWorld(skf, c.x + r * Math.cos(aa), c.y + r * Math.sin(aa));
          const [x2, y2, z2] = sketch2DToWorld(skf, c.x + r * Math.cos(bb), c.y + r * Math.sin(bb));
          verts.push(x1, y1, z1, x2, y2, z2);
        }
      }
      for (const bs of sd.bsplines ?? []) {
        if (bs.auxiliary) continue;
        const deg = bs.degree ?? BSPLINE_DEFAULT_DEGREE;
        const ctrl: { x: number; y: number }[] = [];
        for (const pid of bs.controlPointIds) {
          const p = ptMap.get(pid);
          if (!p) break;
          ctrl.push({ x: p.x, y: p.y });
        }
        if (ctrl.length !== bs.controlPointIds.length || ctrl.length < deg + 1) continue;
        const path = sampleOpenUniformBSpline(ctrl, deg, BSPLINE_DEFAULT_SAMPLES_PER_SPAN);
        for (let i = 0; i < path.length - 1; i++) {
          const [x1, y1, z1] = sketch2DToWorld(skf, path[i].x, path[i].y);
          const [x2, y2, z2] = sketch2DToWorld(skf, path[i + 1].x, path[i + 1].y);
          verts.push(x1, y1, z1, x2, y2, z2);
        }
      }

      // Filled regions in 3D (same concept as sketch mode): detect closed loops and holes.
      // Merge coincident point ids + near-duplicate coordinates so the boundary graph closes.
      const { canonical, mergedPtMap: loopPtMap } = mergeCoincidentSketchVertices(
        sd.points ?? [],
        sd.constraints ?? []
      );
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
        if (l.auxiliary) continue;
        const a = canonical(l.p1Id);
        const b = canonical(l.p2Id);
        if (a === b) continue;
        const p1 = loopPtMap.get(a);
        const p2 = loopPtMap.get(b);
        if (!p1 || !p2) continue;
        edges.push({ id: `l_${l.id}`, a, b, path: [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }] });
      }
      for (const a of (sd.arcs ?? []) as SketchData['arcs']) {
        if (a.auxiliary) continue;
        const ca = canonical(a.centerId);
        const sa = canonical(a.startId);
        const ea = canonical(a.endId);
        const c = loopPtMap.get(ca);
        const s = loopPtMap.get(sa);
        const e = loopPtMap.get(ea);
        if (!c || !s || !e) continue;
        if (sa === ea) continue;
        const path = sampleArcPoints(
          { x: c.x, y: c.y },
          { x: s.x, y: s.y },
          { x: e.x, y: e.y },
          Math.PI / 24,
          { complementaryArc: !!a.complementaryArc }
        );
        if (path.length < 2) continue;
        edges.push({ id: `a_${a.id}`, a: sa, b: ea, path });
      }
      for (const bs of sd.bsplines ?? []) {
        if (bs.auxiliary) continue;
        const deg = bs.degree ?? BSPLINE_DEFAULT_DEGREE;
        const cids = bs.controlPointIds.map((id) => canonical(id));
        const ctrl = cids
          .map((id) => loopPtMap.get(id))
          .filter((p): p is { x: number; y: number } => !!p);
        if (ctrl.length !== cids.length || ctrl.length < deg + 1) continue;
        const path = sampleOpenUniformBSpline(ctrl, deg, BSPLINE_DEFAULT_SAMPLES_PER_SPAN);
        if (path.length < 2) continue;
        const va = cids[0]!;
        const vb = cids[cids.length - 1]!;
        edges.push({ id: `bs_${bs.id}`, a: va, b: vb, path });
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
        let incomingEdgeId = seed.id;
        while (curNode !== startNode) {
          const nbrs = (adj.get(curNode) ?? []).filter((n) => !thisUsed.has(n.edgeId));
          if (!nbrs.length) break;
          const next = pickNextEdgeInFace(curNode, prevNode, incomingEdgeId, nbrs, ptMap, byId) ?? nbrs[0];
          const seg = byId.get(next.edgeId);
          if (!seg) break;
          thisUsed.add(seg.id);
          const forward = seg.a === curNode;
          pts.push(...(forward ? seg.path : [...seg.path].reverse()).slice(1));
          incomingEdgeId = next.edgeId;
          prevNode = curNode;
          curNode = next.other;
        }
        if (curNode === startNode && pts.length >= 3) {
          for (const id of thisUsed) used.add(id);
          const clean = snapClosedPolyline(pts);
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
        if (c.auxiliary) continue;
        const center = loopPtMap.get(canonical(c.centerId));
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
                color={selectedSketchId === wf.id || hoveredSketchId === wf.id ? C_SEL : C_SKETCH_VIEW_FILL}
                transparent
                opacity={
                  selectedSketchId === wf.id || hoveredSketchId === wf.id
                    ? C_SKETCH_VIEW_FILL_SEL_OP
                    : C_SKETCH_VIEW_FILL_OP
                }
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
              color={selectedSketchId === wf.id || hoveredSketchId === wf.id ? C_SEL : C_SKETCH_VIEW_LINE}
            />
          </lineSegments>
        </group>
      ))}
    </>
  );
};

const AXIS_DISPLAY_LEN = 200;

function planeThreeFromRef(
  ref: GeometricSelectionRef | null,
  features: Feature[],
): { n: THREE.Vector3; d: number } | null {
  const eq = planeEquationFromRef(ref, features);
  if (!eq) return null;
  return { n: new THREE.Vector3(eq.n[0], eq.n[1], eq.n[2]), d: eq.d };
}

const AxisFeatures = () => {
  const features = useCadStore((s) => s.features);
  const hiddenGeometryIds = useCadStore((s) => s.hiddenGeometryIds);
  const captureGeometricSelection = useCadStore((s) => s.captureGeometricSelection);

  const axes = useMemo(() => {
    const points = new Map<string, PointFeature>(
      features.filter((f): f is PointFeature => f.type === 'point' && f.enabled !== false).map((f) => [f.id, f]),
    );
    const axisFeatures = features.filter((f): f is AxisFeature => f.type === 'axis' && f.enabled !== false);

    const results: { id: string; name: string; a: THREE.Vector3; b: THREE.Vector3 }[] = [];
    for (const af of axisFeatures) {
      const p = af.parameters;
      let origin: THREE.Vector3 | null = null;
      let dir: THREE.Vector3 | null = null;

      if (p.method === 'twoPoints') {
        const o1 = worldPositionFromAxisTwoPointSlot(p, 1, features);
        const o2 = worldPositionFromAxisTwoPointSlot(p, 2, features);
        if (!o1 || !o2) continue;
        origin = new THREE.Vector3(o1[0], o1[1], o1[2]);
        dir = new THREE.Vector3(o2[0] - o1[0], o2[1] - o1[1], o2[2] - o1[2]);
      } else if (p.method === 'planePoint') {
        const pl = planeThreeFromRef(p.planeRef, features);
        const pref = p.pointRef;
        if (!pl) continue;
        if (pref?.type === 'point' && pref.position) {
          origin = new THREE.Vector3(pref.position[0], pref.position[1], pref.position[2]);
        } else if (p.pointId) {
          const pt = points.get(p.pointId);
          if (!pt) continue;
          origin = new THREE.Vector3(pt.parameters.x, pt.parameters.y, pt.parameters.z);
        } else {
          continue;
        }
        dir = pl.n.clone();
      } else if (p.method === 'twoPlanes') {
        const pa = planeThreeFromRef(p.planeRefA, features);
        const pb = planeThreeFromRef(p.planeRefB, features);
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
        results.push({ id: af.id, name: af.name, a, b });
      }
    }
    return results;
  }, [features, hiddenGeometryIds]);

  const partViewportMode = usePartViewportMode();
  const allowAxisFeaturePick =
    partViewportMode.type === 'selection' && partViewportMode.allowed.includes('axisFeature');

  return (
    <>
      {axes.map((ax) => (
        <group key={ax.id}>
          <Line points={[ax.a, ax.b]} color="#fbbf24" lineWidth={2} />
          {allowAxisFeaturePick && (
            <Line
              points={[ax.a, ax.b]}
              color="#000000"
              lineWidth={12}
              transparent
              opacity={0}
              depthWrite={false}
              renderOrder={3}
              onPointerDown={(e) => {
                e.stopPropagation();
                captureGeometricSelection(
                  {
                    type: 'axisFeature',
                    featureId: ax.id,
                    featureName: ax.name,
                    label: `${ax.name} — Axis`,
                  },
                  false,
                );
              }}
            />
          )}
        </group>
      ))}
    </>
  );
};

const PointFeatures = () => {
  const { features, hiddenGeometryIds, captureGeometricSelection, selectionResetToken } = useCadStore();
  const partViewportMode = usePartViewportMode();
  const allowPointSelection =
    partViewportMode.type === 'selection' && partViewportMode.allowed.includes('point');
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

  const activeInputOptions = useCadStore((s) => s.activeInputOptions);
  const featuresForPointSel = useCadStore((s) => s.features);
  useEffect(() => {
    if (!allowPointSelection) return;
    const pre = activeInputOptions?.preselected;
    const pt = pre?.find((r): r is Extract<GeometricSelectionRef, { type: 'point' }> => r.type === 'point');
    if (pt) {
      const isConstruction = featuresForPointSel.some((f) => f.type === 'point' && f.id === pt.featureId);
      setSelectedPointId(isConstruction ? pt.featureId : null);
    }
  }, [allowPointSelection, activeInputOptions?.preselected, featuresForPointSel]);

  return (
    <>
      {points.map((pf) => {
        const isHovered = hoveredPointId === pf.id;
        const isSelected = selectedPointId === pf.id;
        const color = isSelected ? C_SEL : isHovered ? C_SEL : '#eab308';
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
              captureGeometricSelection(ref, !!(e.ctrlKey || e.shiftKey || e.metaKey));
              setSelectedPointId(pf.id);
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
  const { features, hiddenGeometryIds, captureGeometricSelection, selectionResetToken, activeInputOptions } =
    useCadStore();
  const transientPreviewFeature = useCadStore((s) => s.transientPreviewFeature);
  const partViewportMode = usePartViewportMode();
  const allowPlaneFeatureSelection =
    partViewportMode.type === 'selection' && partViewportMode.allowed.includes('plane');
  const preferSolidFaceOverConstructionPlane =
    allowPlaneFeatureSelection &&
    partViewportMode.type === 'selection' &&
    partViewportMode.allowed.includes('face');
  const [hoveredPlaneId, setHoveredPlaneId] = useState<string | null>(null);
  const [selectedPlaneId, setSelectedPlaneId] = useState<string | null>(null);

  useEffect(() => {
    setHoveredPlaneId(null);
    setSelectedPlaneId(null);
  }, [selectionResetToken]);

  useEffect(() => {
    if (!allowPlaneFeatureSelection) return;
    const pre = activeInputOptions?.preselected;
    const pl = pre?.find((r): r is Extract<GeometricSelectionRef, { type: 'plane' }> => r.type === 'plane');
    if (pl) setSelectedPlaneId(pl.featureId);
  }, [allowPlaneFeatureSelection, activeInputOptions?.preselected]);

  const items = useMemo(() => {
    const out: {
      id: string;
      name: string;
      position: THREE.Vector3;
      quaternion: THREE.Quaternion;
      isPreview?: boolean;
    }[] = [];

    const pushFromPlaneFeature = (pf: PlaneFeature, id: string, name: string, isPreview: boolean) => {
      const eq = planeEquationFromPlaneFeature(pf, features);
      if (!eq) return;
      const p = pf.parameters;
      const n = new THREE.Vector3(eq.n[0], eq.n[1], eq.n[2]).normalize();
      let pos: THREE.Vector3;
      if (p.method === 'offset') {
        pos = n.clone().multiplyScalar(eq.d);
      } else if (p.method === 'threePoints') {
        const w1 = worldPositionFromPlanePointSlot(p, 1, features);
        const w2 = worldPositionFromPlanePointSlot(p, 2, features);
        const w3 = worldPositionFromPlanePointSlot(p, 3, features);
        if (!w1 || !w2 || !w3) return;
        const p1 = new THREE.Vector3(w1[0], w1[1], w1[2]);
        const p2 = new THREE.Vector3(w2[0], w2[1], w2[2]);
        const p3 = new THREE.Vector3(w3[0], w3[1], w3[2]);
        pos = p1.clone().add(p2).add(p3).multiplyScalar(1 / 3);
      } else {
        return;
      }
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      out.push({ id, name, position: pos, quaternion: quat, isPreview });
    };

    for (const f of features) {
      if (f.type !== 'plane' || f.enabled === false) continue;
      if (hiddenGeometryIds.includes(f.id)) continue;
      pushFromPlaneFeature(f as PlaneFeature, f.id, f.name, false);
    }

    if (transientPreviewFeature?.type === 'plane') {
      pushFromPlaneFeature(transientPreviewFeature as PlaneFeature, '__preview__', 'Preview', true);
    }

    return out;
  }, [features, hiddenGeometryIds, transientPreviewFeature]);

  return (
    <>
      {items.map((it) => {
        const isHovered = hoveredPlaneId === it.id;
        const isSelected = selectedPlaneId === it.id;
        const highlight = allowPlaneFeatureSelection && (isHovered || isSelected);
        const isPreview = !!it.isPreview;
        return (
          <mesh
            key={it.id}
            position={it.position}
            quaternion={it.quaternion}
            renderOrder={2}
            raycast={isPreview ? () => null : undefined}
            onPointerOver={(e) => {
              e.stopPropagation();
              if (isPreview || !allowPlaneFeatureSelection) return;
              setHoveredPlaneId(it.id);
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              if (isPreview || !allowPlaneFeatureSelection) return;
              setHoveredPlaneId((prev) => (prev === it.id ? null : prev));
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (isPreview || !allowPlaneFeatureSelection) return;
              if (preferSolidFaceOverConstructionPlane) {
                const faceRef = tryBrepFaceSelectionRefFromIntersections(e.intersections);
                if (faceRef) {
                  captureGeometricSelection(faceRef, !!(e.ctrlKey || e.shiftKey || e.metaKey));
                  return;
                }
              }
              const ref: GeometricSelectionRef = {
                type: 'plane',
                featureId: it.id,
                featureName: it.name,
                label: `${it.name} — Plane`,
              };
              captureGeometricSelection(ref, !!(e.ctrlKey || e.shiftKey || e.metaKey));
              setSelectedPlaneId(it.id);
            }}
          >
            <planeGeometry args={[USER_PLANE_VIS_SIZE, USER_PLANE_VIS_SIZE]} />
            <meshBasicMaterial
              color={isPreview ? '#c084fc' : highlight ? '#f59e0b' : '#a855f7'}
              transparent
              opacity={isPreview ? 0.32 : highlight ? 0.38 : 0.2}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        );
      })}
    </>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Default Reference Planes + intersection axis lines
// ──────────────────────────────────────────────────────────────────────────────
// Plane tint matches the axis normal: XY ⊥ Z (blue), XZ ⊥ Y (green), YZ ⊥ X (red)
const PLANE_CFG: { name: 'xy' | 'xz' | 'yz'; color: string; rot: [number, number, number] }[] = [
  { name: 'xy', color: '#3b82f6', rot: [0, 0, 0] },
  { name: 'xz', color: '#22c55e', rot: [Math.PI / 2, 0, 0] },
  { name: 'yz', color: '#ef4444', rot: [0, Math.PI / 2, 0] },
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
  const { captureGeometricSelection, showOriginPlanes, hiddenGeometryIds, activeInputOptions } =
    useCadStore();
  const [hovPlane, setHovPlane] = useState<string | null>(null);
  const partViewportMode = usePartViewportMode();
  const allowDefaultPlane =
    partViewportMode.type === 'selection' && partViewportMode.allowed.includes('defaultPlane');
  const preferSolidFaceOverOriginPlane =
    allowDefaultPlane &&
    partViewportMode.type === 'selection' &&
    partViewportMode.allowed.includes('face');
  const preselectedDefaultPlaneName = activeInputOptions?.preselected?.find(
    (r): r is Extract<GeometricSelectionRef, { type: 'defaultPlane' }> => r.type === 'defaultPlane',
  )?.name;

  const allowWorldAxisPick =
    partViewportMode.type === 'selection' && partViewportMode.allowed.includes('worldAxis');
  const worldAxisPickMeta = [
    { axis: 'x' as const, points: AXIS_LINES[0].points, label: 'X axis (world)' },
    { axis: 'y' as const, points: AXIS_LINES[1].points, label: 'Y axis (world)' },
    { axis: 'z' as const, points: AXIS_LINES[2].points, label: 'Z axis (world)' },
  ];

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

      {/* Thick invisible lines along origin X/Y/Z for revolution axis (world) picking (always when picking, even if origin planes are hidden) */}
      {allowWorldAxisPick &&
        worldAxisPickMeta.map(({ axis, points, label }) => (
          <Line
            key={`world-axis-pick-${axis}`}
            points={points}
            color="#000000"
            lineWidth={14}
            transparent
            opacity={0}
            depthWrite={false}
            renderOrder={4}
            onPointerDown={(e) => {
              e.stopPropagation();
              captureGeometricSelection({ type: 'worldAxis', axis, label }, false);
            }}
          />
        ))}

      {/* Plane quads */}
      {PLANE_CFG.map(({ name, color, rot }) => (
        (() => {
          const planeId = `origin-${name}`;
          const planeVisible = (allowDefaultPlane) || (!hiddenGeometryIds.includes(planeId) && showPlanes);
          return (
        <mesh
          key={name}
          rotation={rot as any}
          visible={planeVisible}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (partViewportMode.type === 'selection' && allowDefaultPlane) {
              if (preferSolidFaceOverOriginPlane) {
                const faceRef = tryBrepFaceSelectionRefFromIntersections(e.intersections);
                if (faceRef) {
                  captureGeometricSelection(faceRef, !!(e.ctrlKey || e.shiftKey || e.metaKey));
                  return;
                }
              }
              captureGeometricSelection({
                type: 'defaultPlane',
                name,
                label: `${name.toUpperCase()} Plane`,
              }, !!(e.ctrlKey || e.shiftKey || e.metaKey));
            }
          }}
          onPointerOver={(e) => { e.stopPropagation(); if (allowDefaultPlane) setHovPlane(name); }}
          onPointerOut={(e) => { e.stopPropagation(); if (allowDefaultPlane) setHovPlane(null); }}
        >
          <planeGeometry args={[PLANE_SIZE, PLANE_SIZE]} />
          <meshBasicMaterial
            color={
              allowDefaultPlane && (hovPlane === name || preselectedDefaultPlaneName === name)
                ? '#f59e0b'
                : color
            }
            transparent
            opacity={
              allowDefaultPlane && (hovPlane === name || preselectedDefaultPlaneName === name) ? 0.4 : 0.12
            }
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
  const mode = usePartViewportMode();
  if (!activeInputField) return null;
  const selectedFeature = features.find((f) => f.id === selectedFeatureId);
  const objectLabel = selectionHintObjectLabel(mode);
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
