import * as THREE from 'three';
import type { GeometricSelectionRef } from '@/modules/part/store/useCadStore';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';
import type { PartViewportGeometryKind, PartViewportMode } from '@/modules/part/viewport/partViewportMode';
import {
  EDGE_PREFETCH_DIR_DOT_MIN,
  EDGE_PREFETCH_MID_MAX,
  VERTEX_MATCH_TOL_SQ,
} from '@/modules/part/viewport/viewportConstants';

/** Whether a mesh edge is a plausible match for a stored edge ref (parallel + same feature). */
export function edgeRefCouldMatchMeshEdge(
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

export function midpointDistSqToEdge(
  ref: Extract<GeometricSelectionRef, { type: 'edge' }>,
  edge: BRepEdge,
): number {
  const dx = ref.midpoint[0] - edge.mid[0];
  const dy = ref.midpoint[1] - edge.mid[1];
  const dz = ref.midpoint[2] - edge.mid[2];
  return dx * dx + dy * dy + dz * dz;
}

/** One stored ref → at most one mesh edge id (closest midpoint among direction/bbox candidates). */
export function bestMeshEdgeIdForRef(
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

export function faceRefMatchesMeshFace(
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

export function selectionHintObjectLabel(mode: PartViewportMode): string {
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

export function signedArea2D(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return 0.5 * a;
}

export function pointInPoly2D(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
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

export interface BRepFace {
  groupId: number;
  faceId: number;
  geo: THREE.BufferGeometry;
  normal: THREE.Vector3;
}

export interface FacePickData {
  pickType: 'brepFace';
  face: BRepFace;
  featureId: string;
  featureName: string;
}

export function deriveAxisAlignedFaceRef(
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

export function buildFaceSelectionRef(
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

export function tryBrepFaceSelectionRefFromIntersections(
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

export function buildFacesFromMesh(data: SolidMeshData): BRepFace[] {
  const { vertices, normals, triangles, faceGroups } = data;
  const result: BRepFace[] = [];

  for (let gi = 0; gi < faceGroups.length; gi++) {
    const fg = faceGroups[gi];

    const numIdx = fg.count;
    const posArr = new Float32Array(numIdx * 3);
    const norArr = new Float32Array(numIdx * 3);

    for (let fi = 0; fi < numIdx; fi++) {
      const idx = triangles[fg.start + fi];
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

    const avg = new THREE.Vector3();
    for (let fi = 0; fi < numIdx; fi++) avg.add(new THREE.Vector3(norArr[fi * 3], norArr[fi * 3 + 1], norArr[fi * 3 + 2]));
    avg.normalize();

    result.push({ groupId: gi, faceId: fg.faceId, geo, normal: avg });
  }
  return result;
}

export interface BRepEdge {
  id: number;
  points: THREE.Vector3[];
  mid: [number, number, number];
  dir: [number, number, number];
}

export function buildEdgesFromMesh(data: SolidMeshData): BRepEdge[] {
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

export interface BRepMeshVertex {
  id: number;
  position: THREE.Vector3;
}

export function buildVerticesFromEdges(edges: BRepEdge[]): BRepMeshVertex[] {
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

export function bestMeshVertexIdForPointRef(
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
