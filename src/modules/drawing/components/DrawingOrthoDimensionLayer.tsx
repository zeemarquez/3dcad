import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { useDrawingStore } from '../store/useDrawingStore';
import type { DrawingDimensionMode, DrawingSheetDimension } from '../store/useDrawingStore';
import {
  areParallelStraightInView,
  endpointsHorizontalDimBetweenVerticalEdges,
  endpointsVerticalDimBetweenHorizontalEdges,
  extractSolidDimensionPickMeta,
  isHorizontalInView,
  isVerticalInView,
  modelVertexKey,
  pickCircleCenterAtScreen,
  projectedSpanMm,
  validHorizontalDimParallelEdgePair,
  validVerticalDimParallelEdgePair,
} from '../drawingDimensionMath';

const HOVER_PX = 10;
/** Screen px — vertex hit test and zone where vertex wins over collinear straight edges. */
const HOVER_VERTEX_PX = 16;
const DIM_BLACK = '#0a0a0a';
const DIM_ORANGE = '#ea580c';
const EXT_ALPHA = 0.85;
/** World-space mm; arrows scale down on short dimensions (see `effectiveArrowSizeMm`). */
const ARROW_LEN = 0.72;
const ARROW_W = 0.26;
const MIN_ARROW_MM = 0.12;
const TEXT_SCALE = 0.68;
/** Vertex pick markers (world mm radius). */
const VERTEX_MARKER_R = 0.38;
const VERTEX_HOVER_R = 0.22;
/** Approximate half-width of dimension text along the dimension line (mm, world). */
const TEXT_HALF_ALONG_MM = TEXT_SCALE * 2.4;
/**
 * ISO 129 / ISO 3098: offset lettering from the dimension line (≈0.5–1.0× character height).
 * Horizontal: figures placed above the dimension line (+Y). Vertical: outside the part (+X).
 */
const ISO3098_LABEL_PERP_MM = TEXT_SCALE * 0.75;
/** ISO 3098 Type B–style technical lettering (open “osifont”; ISONorm is a common commercial equivalent). */
const DIMENSION_FONT_URL = '/fonts/osifont.ttf';

export function buildWorldEdgeSegments(
  solids: SolidMeshData[],
  q: THREE.Quaternion,
  offset: THREE.Vector3,
): { a: THREE.Vector3; b: THREE.Vector3 }[] {
  const out: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
  const ta = new THREE.Vector3();
  const tb = new THREE.Vector3();
  for (const s of solids) {
    const ev = s.edgeVertices;
    if (!ev || ev.length < 6) continue;
    for (let i = 0; i < ev.length; i += 6) {
      ta.set(ev[i], ev[i + 1], ev[i + 2]).applyQuaternion(q).add(offset);
      tb.set(ev[i + 3], ev[i + 4], ev[i + 5]).applyQuaternion(q).add(offset);
      out.push({ a: ta.clone(), b: tb.clone() });
    }
  }
  return out;
}

/** World-space rim sample → circle center (rim-only tessellation); spatial match avoids key drift. */
type RimSnapWorld = { rim: THREE.Vector3; center: THREE.Vector3 };

/** ~0.25mm — match picked vertex to rim sample despite float / key rounding differences. */
const RIM_SNAP_MATCH_MM = 0.25;

/**
 * If the cursor is within this screen distance of a vertex, that vertex wins over collinear H/V edges
 * (otherwise edge distance 0 along a long line beats a corner vertex a few px away).
 */
function shouldPreferVertexOverStraightEdge(
  ptNear: { dist: number } | null,
  eNear: { dist: number } | null,
): boolean {
  if (!ptNear) return false;
  if (ptNear.dist <= HOVER_VERTEX_PX) return true;
  if (!eNear) return true;
  return ptNear.dist <= eNear.dist;
}

/**
 * All edge endpoints in world space + deduped list for any future use.
 * `vertexPickList` lists every segment endpoint (no merge) so distinct corners never collapse.
 * Circle centers added once. Rim-only points still snap to center in {@link pickWorldPointForDimension}.
 */
function buildWorldVerticesAndCircles(
  solids: SolidMeshData[],
  q: THREE.Quaternion,
  offset: THREE.Vector3,
): {
  /** Dense list for hover/pick — one entry per edge endpoint + circle centers (no key dedup). */
  vertexPickList: THREE.Vector3[];
  circlesWorld: { center: THREE.Vector3; rim: THREE.Vector3[] }[];
  rimSnaps: RimSnapWorld[];
} {
  const vertexPickList: THREE.Vector3[] = [];
  const t = new THREE.Vector3();
  const circlesWorld: { center: THREE.Vector3; rim: THREE.Vector3[] }[] = [];
  const rimSnaps: RimSnapWorld[] = [];

  for (const s of solids) {
    const { circles, rimOnlyExcludeModelKeys } = extractSolidDimensionPickMeta(s);
    for (const info of circles) {
      const centerW = info.centerModel.clone().applyQuaternion(q).add(offset);
      const rimW = info.rimModel.map((p) => p.clone().applyQuaternion(q).add(offset));
      circlesWorld.push({ center: centerW, rim: rimW });
      for (let i = 0; i < info.rimModel.length; i++) {
        const p = info.rimModel[i];
        if (!rimOnlyExcludeModelKeys.has(modelVertexKey(p.x, p.y, p.z))) continue;
        rimSnaps.push({ rim: rimW[i]!, center: centerW.clone() });
      }
    }

    const ev = s.edgeVertices;
    if (!ev || ev.length < 6) continue;
    for (let i = 0; i < ev.length; i += 6) {
      for (const k of [0, 3]) {
        t.set(ev[i + k], ev[i + k + 1], ev[i + k + 2]);
        t.applyQuaternion(q).add(offset);
        vertexPickList.push(t.clone());
      }
    }
    for (const info of circles) {
      t.copy(info.centerModel).applyQuaternion(q).add(offset);
      vertexPickList.push(t.clone());
    }
  }

  return { vertexPickList, circlesWorld, rimSnaps };
}

function substituteRimPickForCircleCenter(
  picked: THREE.Vector3,
  rimSnaps: RimSnapWorld[],
): THREE.Vector3 | null {
  let bestCenter: THREE.Vector3 | null = null;
  let bestD = RIM_SNAP_MATCH_MM;
  for (const { rim, center } of rimSnaps) {
    const d = picked.distanceTo(rim);
    if (d < bestD) {
      bestD = d;
      bestCenter = center;
    }
  }
  return bestCenter;
}

function screenDistToPoint(
  p: THREE.Vector3,
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
): number {
  const t = p.clone().project(camera);
  const px = (t.x * 0.5 + 0.5) * w;
  const py = (-t.y * 0.5 + 0.5) * h;
  return Math.hypot(cx - px, cy - py);
}

function pickWorldPointForDimension(
  vertexPickList: THREE.Vector3[],
  circlesWorld: { center: THREE.Vector3; rim: THREE.Vector3[] }[],
  rimSnaps: RimSnapWorld[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
): { point: THREE.Vector3; dist: number } | null {
  const vHitRaw = pickNearestVertexAt(vertexPickList, cx, cy, camera, w, h, HOVER_VERTEX_PX);
  let vHit = vHitRaw;
  if (vHit) {
    const sub = substituteRimPickForCircleCenter(vHit.point, rimSnaps);
    if (sub) {
      vHit = { point: sub, dist: screenDistToPoint(sub, cx, cy, camera, w, h) };
    }
  }
  const cCenter = pickCircleCenterAtScreen(circlesWorld, cx, cy, camera, w, h, HOVER_VERTEX_PX);
  let cDist = Infinity;
  if (cCenter) {
    cDist = screenDistToPoint(cCenter, cx, cy, camera, w, h);
  }
  if (vHit && cCenter) {
    if (cDist < vHit.dist) return { point: cCenter, dist: cDist };
    return vHit;
  }
  if (vHit) return vHit;
  if (cCenter) return { point: cCenter, dist: cDist };
  return null;
}

function distToSeg2(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Pointer position in the same pixel space as @react-three/fiber `size` / `Vector3.project` —
 * critical when canvas CSS size ≠ internal buffer or with DPR scaling.
 */
function pointerInFiberCanvasSpace(
  e: { clientX: number; clientY: number },
  canvas: HTMLCanvasElement,
  fiberW: number,
  fiberH: number,
): { cx: number; cy: number; w: number; h: number } {
  const rect = canvas.getBoundingClientRect();
  const rw = Math.max(rect.width, 1e-6);
  const rh = Math.max(rect.height, 1e-6);
  return {
    cx: ((e.clientX - rect.left) / rw) * fiberW,
    cy: ((e.clientY - rect.top) / rh) * fiberH,
    w: fiberW,
    h: fiberH,
  };
}

function projectSegmentToCanvas(
  a: THREE.Vector3,
  b: THREE.Vector3,
  camera: THREE.Camera,
  w: number,
  h: number,
): { ax: number; ay: number; bx: number; by: number } {
  const ta = a.clone().project(camera);
  const tb = b.clone().project(camera);
  return {
    ax: (ta.x * 0.5 + 0.5) * w,
    ay: (-ta.y * 0.5 + 0.5) * h,
    bx: (tb.x * 0.5 + 0.5) * w,
    by: (-tb.y * 0.5 + 0.5) * h,
  };
}

function pickDimensionIdAt(
  dimensions: DrawingSheetDimension[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
): string | null {
  let best: { id: string; d: number } | null = null;
  for (const dim of dimensions) {
    const d = distanceToDimensionLabelPick(dim, cx, cy, camera, w, h);
    /** Pixels — generous slack after NDC + fiber/canvas alignment. */
    if (d <= 56 && (!best || d < best.d)) {
      best = { id: dim.id, d };
    }
  }
  return best?.id ?? null;
}

function pickStraightEdgeIndexAt(
  segments: { a: THREE.Vector3; b: THREE.Vector3 }[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
  dimensionMode: 'horizontal' | 'vertical',
): number | null {
  let bestI: number | null = null;
  let bestD = HOVER_PX + 1;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const { ax, ay, bx, by } = projectSegmentToCanvas(seg.a, seg.b, camera, w, h);
    const d = distToSeg2(cx, cy, ax, ay, bx, by);
    if (d < bestD && d <= HOVER_PX) {
      const ok =
        dimensionMode === 'horizontal' ? isHorizontalInView(seg.a, seg.b) : isVerticalInView(seg.a, seg.b);
      if (ok) {
        bestD = d;
        bestI = i;
      }
    }
  }
  return bestI;
}

function pickNearestVertexAt(
  vertices: THREE.Vector3[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
  maxPx: number,
): { point: THREE.Vector3; dist: number } | null {
  let best: { point: THREE.Vector3; dist: number } | null = null;
  for (const p of vertices) {
    const t = p.clone().project(camera);
    const px = (t.x * 0.5 + 0.5) * w;
    const py = (-t.y * 0.5 + 0.5) * h;
    const d = Math.hypot(cx - px, cy - py);
    if (d <= maxPx && (!best || d < best.dist)) best = { point: p, dist: d };
  }
  return best;
}

function findNearestStraightEdgeWithDist(
  segments: { a: THREE.Vector3; b: THREE.Vector3 }[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
  maxPx: number,
  dimensionMode: 'horizontal' | 'vertical',
): { index: number; dist: number } | null {
  let best: { index: number; dist: number } | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const ok =
      dimensionMode === 'horizontal' ? isHorizontalInView(seg.a, seg.b) : isVerticalInView(seg.a, seg.b);
    if (!ok) continue;
    const { ax, ay, bx, by } = projectSegmentToCanvas(seg.a, seg.b, camera, w, h);
    const d = distToSeg2(cx, cy, ax, ay, bx, by);
    if (d <= maxPx && (!best || d < best.dist)) best = { index: i, dist: d };
  }
  return best;
}

function closestTOnSegmentCanvas(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return 0;
  return Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
}

/**
 * Horizontal dimension ↔ vertical edges in view; vertical dimension ↔ horizontal edges.
 * Used for point-to-line second picks and related hovers.
 */
function findNearestOrthoEdgeWithDist(
  segments: { a: THREE.Vector3; b: THREE.Vector3 }[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
  maxPx: number,
  dimensionMode: 'horizontal' | 'vertical',
): { index: number; dist: number; closestWorld: THREE.Vector3 } | null {
  let best: { index: number; dist: number; closestWorld: THREE.Vector3 } | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const ok =
      dimensionMode === 'horizontal' ? isVerticalInView(seg.a, seg.b) : isHorizontalInView(seg.a, seg.b);
    if (!ok) continue;
    const { ax, ay, bx, by } = projectSegmentToCanvas(seg.a, seg.b, camera, w, h);
    const d = distToSeg2(cx, cy, ax, ay, bx, by);
    if (d <= maxPx && (!best || d < best.dist)) {
      const t = closestTOnSegmentCanvas(cx, cy, ax, ay, bx, by);
      const closestWorld = new THREE.Vector3().copy(seg.a).lerp(seg.b, t);
      best = { index: i, dist: d, closestWorld };
    }
  }
  return best;
}

/**
 * First pick (no pending): Shift = only the parallel-edge family (vertical for H dim, horizontal for V dim).
 * Otherwise vertex/circle vs aligned straight edge — never diagonal mesh edges.
 */
function computeIdleDimensionPickHover(
  shiftKey: boolean,
  mode: 'horizontal' | 'vertical',
  vertexPickList: THREE.Vector3[],
  circlesWorld: { center: THREE.Vector3; rim: THREE.Vector3[] }[],
  rimSnaps: RimSnapWorld[],
  segments: { a: THREE.Vector3; b: THREE.Vector3 }[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
): { hoverSnapVertex: { x: number; y: number; z: number } | null; hoverEdgeIndex: number | null } {
  if (shiftKey) {
    const eOrtho = findNearestOrthoEdgeWithDist(segments, cx, cy, camera, w, h, HOVER_PX, mode);
    return {
      hoverSnapVertex: null,
      hoverEdgeIndex: eOrtho ? eOrtho.index : null,
    };
  }
  const ptNear = pickWorldPointForDimension(vertexPickList, circlesWorld, rimSnaps, cx, cy, camera, w, h);
  const eNear = findNearestStraightEdgeWithDist(segments, cx, cy, camera, w, h, HOVER_PX, mode);
  const preferVertex = shouldPreferVertexOverStraightEdge(ptNear, eNear);
  if (preferVertex && ptNear) {
    return {
      hoverSnapVertex: { x: ptNear.point.x, y: ptNear.point.y, z: ptNear.point.z },
      hoverEdgeIndex: null,
    };
  }
  if (eNear) {
    return { hoverSnapVertex: null, hoverEdgeIndex: eNear.index };
  }
  return { hoverSnapVertex: null, hoverEdgeIndex: null };
}

/** Second point after placing first vertex: another vertex, or closest point on an orthogonal straight edge. */
function pickPendingSecondAttachment(
  vertexPickList: THREE.Vector3[],
  circlesWorld: { center: THREE.Vector3; rim: THREE.Vector3[] }[],
  rimSnaps: RimSnapWorld[],
  segments: { a: THREE.Vector3; b: THREE.Vector3 }[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
  dimensionMode: 'horizontal' | 'vertical',
):
  | { kind: 'vertex'; point: THREE.Vector3; dist: number }
  | { kind: 'edge'; point: THREE.Vector3; dist: number; edgeIndex: number }
  | null {
  const vHit = pickWorldPointForDimension(
    vertexPickList,
    circlesWorld,
    rimSnaps,
    cx,
    cy,
    camera,
    w,
    h,
  );
  const eOrtho = findNearestOrthoEdgeWithDist(segments, cx, cy, camera, w, h, HOVER_PX, dimensionMode);
  if (!vHit && !eOrtho) return null;
  if (!eOrtho) return { kind: 'vertex', point: vHit!.point, dist: vHit!.dist };
  if (!vHit) return { kind: 'edge', point: eOrtho.closestWorld, dist: eOrtho.dist, edgeIndex: eOrtho.index };
  if (vHit.dist <= eOrtho.dist) return { kind: 'vertex', point: vHit.point, dist: vHit.dist };
  return { kind: 'edge', point: eOrtho.closestWorld, dist: eOrtho.dist, edgeIndex: eOrtho.index };
}

function findNearestParallelEdgeForPending(
  segments: { a: THREE.Vector3; b: THREE.Vector3 }[],
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
  maxPx: number,
  refIndex: number,
  dimensionMode: 'horizontal' | 'vertical',
): { index: number; dist: number } | null {
  const s0 = segments[refIndex];
  if (!s0) return null;
  let best: { index: number; dist: number } | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!areParallelStraightInView(s0.a, s0.b, seg.a, seg.b)) continue;
    if (
      dimensionMode === 'horizontal' &&
      !validHorizontalDimParallelEdgePair(s0.a, s0.b, seg.a, seg.b)
    ) {
      continue;
    }
    if (
      dimensionMode === 'vertical' &&
      !validVerticalDimParallelEdgePair(s0.a, s0.b, seg.a, seg.b)
    ) {
      continue;
    }
    const { ax, ay, bx, by } = projectSegmentToCanvas(seg.a, seg.b, camera, w, h);
    const d = distToSeg2(cx, cy, ax, ay, bx, by);
    if (d <= maxPx && (!best || d < best.dist)) best = { index: i, dist: d };
  }
  return best;
}

/** Matches `<Text position … z+0.15 />` in {@link IsoDimensionLines}. */
const LABEL_POS_Z_OFFSET = 0.15;

/**
 * Distance in screen px from (cx,cy) to the label hit region. Uses NDC (same as `Vector3.project`)
 * plus a generous troika/drei text bounds in world space. `cx,cy,w,h` must be {@link pointerInFiberCanvasSpace}.
 */
function distanceToDimensionLabelPick(
  dim: DrawingSheetDimension,
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
): number {
  camera.updateMatrixWorld(true);
  if ('updateProjectionMatrix' in camera && typeof camera.updateProjectionMatrix === 'function') {
    camera.updateProjectionMatrix();
  }

  const layout = isoDimensionLayout(dim);
  const span = projectedSpanMm(
    dim.kind,
    new THREE.Vector3(dim.ax, dim.ay, dim.az),
    new THREE.Vector3(dim.bx, dim.by, dim.bz),
  );
  const str = `${span.toFixed(2)}`;
  const letterPad = TEXT_SCALE * 0.05 * Math.max(0, str.length - 1);
  const halfAlong =
    (Math.max(TEXT_HALF_ALONG_MM * 1.25, str.length * TEXT_SCALE * 0.6) + letterPad * 0.5) * 1.4;
  const halfPerp = TEXT_SCALE * 1.15;

  const center = layout.labelPos.clone();
  center.z += LABEL_POS_Z_OFFSET;

  const qRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, layout.textRotationZ));
  const along = new THREE.Vector3(1, 0, 0).applyQuaternion(qRot);
  const perp = new THREE.Vector3(0, 1, 0).applyQuaternion(qRot);

  const corners: THREE.Vector3[] = [
    center.clone().addScaledVector(along, halfAlong).addScaledVector(perp, halfPerp),
    center.clone().addScaledVector(along, halfAlong).addScaledVector(perp, -halfPerp),
    center.clone().addScaledVector(along, -halfAlong).addScaledVector(perp, -halfPerp),
    center.clone().addScaledVector(along, -halfAlong).addScaledVector(perp, halfPerp),
  ];

  let minNdcX = Infinity;
  let maxNdcX = -Infinity;
  let minNdcY = Infinity;
  let maxNdcY = -Infinity;
  for (const p of corners) {
    const ndc = p.clone().project(camera);
    const x = ndc.x;
    const y = ndc.y;
    minNdcX = Math.min(minNdcX, x);
    maxNdcX = Math.max(maxNdcX, x);
    minNdcY = Math.min(minNdcY, y);
    maxNdcY = Math.max(maxNdcY, y);
  }

  if (!Number.isFinite(minNdcX)) return Infinity;

  const padNdc = 0.04;
  minNdcX -= padNdc;
  maxNdcX += padNdc;
  minNdcY -= padNdc;
  maxNdcY += padNdc;

  const ndcMx = (cx / w) * 2 - 1;
  const ndcMy = -(cy / h) * 2 + 1;

  const dxNdc = ndcMx < minNdcX ? minNdcX - ndcMx : ndcMx > maxNdcX ? ndcMx - maxNdcX : 0;
  const dyNdc = ndcMy < minNdcY ? minNdcY - ndcMy : ndcMy > maxNdcY ? ndcMy - maxNdcY : 0;
  const distBoxPx = Math.hypot(dxNdc * (w / 2), dyNdc * (h / 2));

  const cNdc = center.clone().project(camera);
  const distCenterPx = Math.hypot(
    ((cNdc.x - ndcMx) * w) / 2,
    ((cNdc.y - ndcMy) * h) / 2,
  );

  return Math.min(distBoxPx, distCenterPx);
}

/** Pick & hover edges; draw dimensions; selection + drag (offset ⟂, along ∥ to measurement). */
export function DrawingOrthoDimensionLayer({
  solids,
  q,
  offset,
  viewId,
  dimensionMode,
  dimensions,
  onAddDimension,
  onUpdateDimensionGeometry,
  onDimensionContextMenu,
}: {
  solids: SolidMeshData[];
  q: THREE.Quaternion;
  offset: THREE.Vector3;
  viewId: string;
  dimensionMode: DrawingDimensionMode;
  dimensions: DrawingSheetDimension[];
  onAddDimension: (d: Omit<DrawingSheetDimension, 'id'>) => void;
  onUpdateDimensionGeometry: (id: string, patch: { offsetMm?: number; alongMm?: number }) => void;
  /** Right-click on a dimension to open a sheet-level menu (e.g. delete). */
  onDimensionContextMenu?: (detail: { dimensionId: string; clientX: number; clientY: number }) => void;
}) {
  const { camera, gl, size } = useThree();
  const canvasW = size.width;
  const canvasH = size.height;
  const setHoveredDimensionId = useDrawingStore((s) => s.setHoveredDimensionId);
  const setSelectedDimensionId = useDrawingStore((s) => s.setSelectedDimensionId);
  const selectedDimensionId = useDrawingStore((s) => s.selectedDimensionId);

  const segments = useMemo(() => buildWorldEdgeSegments(solids, q, offset), [solids, q, offset]);
  const { vertexPickList, circlesWorld, rimSnaps } = useMemo(
    () => buildWorldVerticesAndCircles(solids, q, offset),
    [solids, q, offset],
  );
  /** Last pointer position on the view canvas (for Shift hover refresh without moving). */
  const lastDimPointerRef = useRef<{ cx: number; cy: number; w: number; h: number } | null>(null);
  const [hoverEdgeIndex, setHoverEdgeIndex] = useState<number | null>(null);
  const hoverEdgeIndexRef = useRef<number | null>(null);
  const [pendingVertex, setPendingVertex] = useState<{ x: number; y: number; z: number } | null>(null);
  const [pendingEdgeIndex, setPendingEdgeIndex] = useState<number | null>(null);
  const [hoverSnapVertex, setHoverSnapVertex] = useState<{ x: number; y: number; z: number } | null>(null);

  const dragRef = useRef<{
    id: string;
    startOffset: number;
    startAlong: number;
    startClientX: number;
    startClientY: number;
    viewWidthPx: number;
    viewHeightPx: number;
    viewSpanMm: number;
    viewSpanXMm: number;
    kind: 'horizontal' | 'vertical';
  } | null>(null);

  const hoverSeg = useMemo(() => {
    return hoverEdgeIndex != null && hoverEdgeIndex < segments.length ? segments[hoverEdgeIndex] : null;
  }, [segments, hoverEdgeIndex]);

  const pendingFirstEdgeGeom = useMemo(() => {
    if (pendingEdgeIndex == null || pendingEdgeIndex >= segments.length) return null;
    const seg = segments[pendingEdgeIndex];
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([seg.a.x, seg.a.y, seg.a.z, seg.b.x, seg.b.y, seg.b.z]),
        3,
      ),
    );
    return g;
  }, [pendingEdgeIndex, segments]);

  useEffect(() => {
    setPendingVertex(null);
    setPendingEdgeIndex(null);
    setHoverSnapVertex(null);
  }, [dimensionMode]);

  useEffect(() => {
    const el = gl.domElement;

    const onMove = (e: PointerEvent) => {
      if (dragRef.current) return;
      const { cx, cy, w, h } = pointerInFiberCanvasSpace(e, el, canvasW, canvasH);

      if (dimensionMode) {
        setHoveredDimensionId(null);
      } else {
        const dimUnder = pickDimensionIdAt(dimensions, cx, cy, camera, w, h);
        setHoveredDimensionId(dimUnder);
        if (dimUnder) {
          hoverEdgeIndexRef.current = null;
          setHoverEdgeIndex(null);
          setHoverSnapVertex(null);
          return;
        }
      }

      if (!dimensionMode) {
        lastDimPointerRef.current = null;
        hoverEdgeIndexRef.current = null;
        setHoverEdgeIndex(null);
        setHoverSnapVertex(null);
        return;
      }

      lastDimPointerRef.current = { cx, cy, w, h };

      const mode = dimensionMode;

      let bestI: number | null = null;

      if (pendingEdgeIndex != null) {
        const ePar = findNearestParallelEdgeForPending(
          segments,
          cx,
          cy,
          camera,
          w,
          h,
          HOVER_PX,
          pendingEdgeIndex,
          mode,
        );
        bestI = ePar?.index ?? null;
        hoverEdgeIndexRef.current = bestI;
        setHoverEdgeIndex((prev) => (prev === bestI ? prev : bestI));
        setHoverSnapVertex(null);
        return;
      }

      if (pendingVertex != null) {
        const second = pickPendingSecondAttachment(
          vertexPickList,
          circlesWorld,
          rimSnaps,
          segments,
          cx,
          cy,
          camera,
          w,
          h,
          mode,
        );
        if (second) {
          setHoverSnapVertex({ x: second.point.x, y: second.point.y, z: second.point.z });
          if (second.kind === 'edge') {
            hoverEdgeIndexRef.current = second.edgeIndex;
            setHoverEdgeIndex(second.edgeIndex);
          } else {
            hoverEdgeIndexRef.current = null;
            setHoverEdgeIndex(null);
          }
        } else {
          setHoverSnapVertex(null);
          hoverEdgeIndexRef.current = null;
          setHoverEdgeIndex(null);
        }
        return;
      }

      const idle = computeIdleDimensionPickHover(
        e.shiftKey,
        mode,
        vertexPickList,
        circlesWorld,
        rimSnaps,
        segments,
        cx,
        cy,
        camera,
        w,
        h,
      );
      bestI = idle.hoverEdgeIndex;
      setHoverSnapVertex(idle.hoverSnapVertex);
      hoverEdgeIndexRef.current = bestI;
      setHoverEdgeIndex((prev) => (prev === bestI ? prev : bestI));
    };

    const onLeave = () => {
      setHoveredDimensionId(null);
      hoverEdgeIndexRef.current = null;
      setHoverEdgeIndex(null);
      setHoverSnapVertex(null);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const { cx, cy, w, h } = pointerInFiberCanvasSpace(e, el, canvasW, canvasH);

      if (!dimensionMode) {
        const dimUnder = pickDimensionIdAt(dimensions, cx, cy, camera, w, h);
        if (dimUnder) {
          const dim = dimensions.find((d) => d.id === dimUnder);
          if (!dim) return;
          setSelectedDimensionId(dimUnder);
          dragRef.current = {
            id: dimUnder,
            startOffset: dim.offsetMm,
            startAlong: dim.alongMm ?? 0,
            startClientX: e.clientX,
            startClientY: e.clientY,
            viewWidthPx: rect.width,
            viewHeightPx: rect.height,
            viewSpanMm: (camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom,
            viewSpanXMm: (camera as THREE.OrthographicCamera).right - (camera as THREE.OrthographicCamera).left,
            kind: dim.kind,
          };
          el.setPointerCapture(e.pointerId);
          e.stopPropagation();
          e.preventDefault();
          return;
        }
      }

      if (dimensionMode) {
        const mode = dimensionMode;
        const ortho = camera as THREE.OrthographicCamera;
        const defaultOff = Math.min(14, (ortho.top - ortho.bottom) * 0.06);

        const addDim = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
          onAddDimension({
            viewId,
            kind: mode,
            ax,
            ay,
            az,
            bx,
            by,
            bz,
            offsetMm: defaultOff,
            alongMm: 0,
          });
        };

        if (pendingVertex != null) {
          const second = pickPendingSecondAttachment(
            vertexPickList,
            circlesWorld,
            rimSnaps,
            segments,
            cx,
            cy,
            camera,
            w,
            h,
            mode,
          );
          if (second) {
            const a = new THREE.Vector3(pendingVertex.x, pendingVertex.y, pendingVertex.z);
            const b = second.point;
            const span = projectedSpanMm(mode, a, b);
            if (span < 1e-9) {
              setPendingVertex(null);
              e.stopPropagation();
              e.preventDefault();
              return;
            }
            addDim(a.x, a.y, a.z, b.x, b.y, b.z);
            setPendingVertex(null);
            e.stopPropagation();
            e.preventDefault();
            return;
          }
          setPendingVertex(null);
          e.stopPropagation();
          e.preventDefault();
          return;
        }

        if (pendingEdgeIndex != null) {
          const ePar = findNearestParallelEdgeForPending(
            segments,
            cx,
            cy,
            camera,
            w,
            h,
            HOVER_PX,
            pendingEdgeIndex,
            mode,
          );
          if (!ePar) {
            setPendingEdgeIndex(null);
            e.stopPropagation();
            e.preventDefault();
            return;
          }
          const i0 = pendingEdgeIndex;
          const i1 = ePar.index;
          const s0 = segments[i0];
          const s1 = segments[i1];
          if (i0 === i1) {
            const span = projectedSpanMm(mode, s0.a, s0.b);
            if (span < 1e-6) {
              setPendingEdgeIndex(null);
              e.stopPropagation();
              e.preventDefault();
              return;
            }
            addDim(s0.a.x, s0.a.y, s0.a.z, s0.b.x, s0.b.y, s0.b.z);
            setPendingEdgeIndex(null);
            e.stopPropagation();
            e.preventDefault();
            return;
          }
          let a: THREE.Vector3;
          let b: THREE.Vector3;
          if (mode === 'horizontal') {
            ({ a, b } = endpointsHorizontalDimBetweenVerticalEdges(s0.a, s0.b, s1.a, s1.b));
          } else {
            ({ a, b } = endpointsVerticalDimBetweenHorizontalEdges(s0.a, s0.b, s1.a, s1.b));
          }
          const span = projectedSpanMm(mode, a, b);
          if (span < 1e-9) {
            setPendingEdgeIndex(null);
            e.stopPropagation();
            e.preventDefault();
            return;
          }
          addDim(a.x, a.y, a.z, b.x, b.y, b.z);
          setPendingEdgeIndex(null);
          e.stopPropagation();
          e.preventDefault();
          return;
        }

        if (e.shiftKey) {
          const eOrtho = findNearestOrthoEdgeWithDist(segments, cx, cy, camera, w, h, HOVER_PX, mode);
          if (eOrtho) {
            setPendingEdgeIndex(eOrtho.index);
            e.stopPropagation();
            e.preventDefault();
            return;
          }
          e.stopPropagation();
          e.preventDefault();
          return;
        }

        const ptNear = pickWorldPointForDimension(vertexPickList, circlesWorld, rimSnaps, cx, cy, camera, w, h);
        const eNear = findNearestStraightEdgeWithDist(segments, cx, cy, camera, w, h, HOVER_PX, mode);
        const preferVertex = shouldPreferVertexOverStraightEdge(ptNear, eNear);

        if (preferVertex && ptNear) {
          setPendingVertex({ x: ptNear.point.x, y: ptNear.point.y, z: ptNear.point.z });
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        if (eNear) {
          const seg = segments[eNear.index];
          const span = projectedSpanMm(mode, seg.a, seg.b);
          if (span < 1e-6) return;
          addDim(seg.a.x, seg.a.y, seg.a.z, seg.b.x, seg.b.y, seg.b.z);
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        return;
      }

      setSelectedDimensionId(null);
    };

    const onMoveDrag = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dxPx = e.clientX - d.startClientX;
      const dyPx = e.clientY - d.startClientY;
      const dxMm = (dxPx / d.viewWidthPx) * d.viewSpanXMm;
      const dyMm = (dyPx / d.viewHeightPx) * d.viewSpanMm;
      let nextOff: number;
      let nextAlong: number;
      if (d.kind === 'horizontal') {
        // Perpendicular: offset increases ⇒ dimension line moves −Y (yDim = min − offset). Screen Y is
        // inverted vs world Y, so +mouse-down ⇒ +offset matches moving the line with the cursor.
        nextOff = d.startOffset + dyMm;
        // Along world +X: screen X+ ⇒ world +X.
        nextAlong = d.startAlong + dxMm;
      } else {
        // Perpendicular: xDim = max + offset; +mouse-right ⇒ +offset.
        nextOff = d.startOffset + dxMm;
        // Along world +Y: screen Y increases downward; world +Y is screen up ⇒ negate dyMm.
        nextAlong = d.startAlong - dyMm;
      }
      onUpdateDimensionGeometry(d.id, {
        offsetMm: Math.max(-400, Math.min(400, nextOff)),
        alongMm: Math.max(-3000, Math.min(3000, nextAlong)),
      });
    };

    const onUpDrag = (e: PointerEvent) => {
      if (!dragRef.current) return;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* */
      }
      dragRef.current = null;
    };

    const onContextMenu = (e: MouseEvent) => {
      if (!onDimensionContextMenu) return;
      if (dimensionMode) return;
      const { cx, cy, w, h } = pointerInFiberCanvasSpace(e, el, canvasW, canvasH);
      const dimUnder = pickDimensionIdAt(dimensions, cx, cy, camera, w, h);
      if (!dimUnder) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedDimensionId(dimUnder);
      onDimensionContextMenu({ dimensionId: dimUnder, clientX: e.clientX, clientY: e.clientY });
    };

    const onShiftKeyHover = (ev: KeyboardEvent) => {
      if (ev.key !== 'Shift') return;
      if (!dimensionMode) return;
      if (pendingEdgeIndex != null || pendingVertex != null) return;
      const L = lastDimPointerRef.current;
      if (!L) return;
      const idle = computeIdleDimensionPickHover(
        ev.shiftKey,
        dimensionMode,
        vertexPickList,
        circlesWorld,
        rimSnaps,
        segments,
        L.cx,
        L.cy,
        camera,
        L.w,
        L.h,
      );
      hoverEdgeIndexRef.current = idle.hoverEdgeIndex;
      setHoverEdgeIndex(idle.hoverEdgeIndex);
      setHoverSnapVertex(idle.hoverSnapVertex);
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointermove', onMoveDrag);
    window.addEventListener('pointerup', onUpDrag);
    window.addEventListener('pointercancel', onUpDrag);
    window.addEventListener('keydown', onShiftKeyHover);
    window.addEventListener('keyup', onShiftKeyHover);

    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointermove', onMoveDrag);
      window.removeEventListener('pointerup', onUpDrag);
      window.removeEventListener('pointercancel', onUpDrag);
      window.removeEventListener('keydown', onShiftKeyHover);
      window.removeEventListener('keyup', onShiftKeyHover);
    };
  }, [
    camera,
    gl,
    dimensionMode,
    dimensions,
    onAddDimension,
    onUpdateDimensionGeometry,
    onDimensionContextMenu,
    pendingEdgeIndex,
    pendingVertex,
    segments,
    setHoveredDimensionId,
    setSelectedDimensionId,
    viewId,
    vertexPickList,
    circlesWorld,
    rimSnaps,
    canvasW,
    canvasH,
  ]);

  const hoverGeom = useMemo(() => {
    if (!hoverSeg) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([hoverSeg.a.x, hoverSeg.a.y, hoverSeg.a.z, hoverSeg.b.x, hoverSeg.b.y, hoverSeg.b.z]),
        3,
      ),
    );
    return g;
  }, [hoverSeg]);

  useEffect(
    () => () => {
      hoverGeom?.dispose();
    },
    [hoverGeom],
  );

  useEffect(
    () => () => {
      pendingFirstEdgeGeom?.dispose();
    },
    [pendingFirstEdgeGeom],
  );

  const hoveredDimensionId = useDrawingStore((s) => s.hoveredDimensionId);

  const snapSameAsPending =
    pendingVertex &&
    hoverSnapVertex &&
    Math.hypot(
      pendingVertex.x - hoverSnapVertex.x,
      pendingVertex.y - hoverSnapVertex.y,
      pendingVertex.z - hoverSnapVertex.z,
    ) < 1e-4;

  return (
    <>
      {pendingFirstEdgeGeom && dimensionMode && (
        <lineSegments geometry={pendingFirstEdgeGeom} renderOrder={8}>
          <lineBasicMaterial color="#2563eb" depthTest={false} depthWrite={false} />
        </lineSegments>
      )}
      {pendingVertex && dimensionMode && (
        <mesh position={[pendingVertex.x, pendingVertex.y, pendingVertex.z + 0.2]} renderOrder={10}>
          <sphereGeometry args={[VERTEX_MARKER_R, 12, 12]} />
          <meshBasicMaterial color={DIM_ORANGE} depthTest={false} depthWrite={false} />
        </mesh>
      )}
      {hoverSnapVertex && dimensionMode && !snapSameAsPending && (
        <mesh position={[hoverSnapVertex.x, hoverSnapVertex.y, hoverSnapVertex.z + 0.21]} renderOrder={11}>
          <sphereGeometry args={[VERTEX_HOVER_R, 10, 10]} />
          <meshBasicMaterial color="#fbbf24" depthTest={false} depthWrite={false} />
        </mesh>
      )}
      {hoverGeom && dimensionMode && (
        <lineSegments geometry={hoverGeom} renderOrder={9}>
          <lineBasicMaterial color={DIM_ORANGE} depthTest={false} depthWrite={false} />
        </lineSegments>
      )}
      {dimensions.map((dim) => (
        <IsoDimensionLines
          key={dim.id}
          dim={dim}
          highlight={
            selectedDimensionId === dim.id
              ? 'selected'
              : hoveredDimensionId === dim.id
                ? 'hover'
                : 'none'
          }
        />
      ))}
    </>
  );
}

function isoDimensionWorldPoints(dim: DrawingSheetDimension) {
  const { ax, ay, az, bx, by, bz, kind, offsetMm } = dim;
  const alongMm = dim.alongMm ?? 0;
  if (kind === 'horizontal') {
    const yDim = Math.min(ay, by) - offsetMm;
    const zLine = (az + bz) / 2;
    const ext1a = new THREE.Vector3(ax, ay, az);
    const ext1b = new THREE.Vector3(ax, yDim, zLine);
    const ext2a = new THREE.Vector3(bx, by, bz);
    const ext2b = new THREE.Vector3(bx, yDim, zLine);
    const dima = new THREE.Vector3(ax, yDim, zLine);
    const dimb = new THREE.Vector3(bx, yDim, zLine);
    const label = new THREE.Vector3((ax + bx) / 2 + alongMm, yDim, zLine);
    return { ext1a, ext1b, ext2a, ext2b, dima, dimb, label };
  }
  const xDim = Math.max(ax, bx) + offsetMm;
  const zLine = (az + bz) / 2;
  const ext1a = new THREE.Vector3(ax, ay, az);
  const ext1b = new THREE.Vector3(xDim, ay, zLine);
  const ext2a = new THREE.Vector3(bx, by, bz);
  const ext2b = new THREE.Vector3(xDim, by, zLine);
  const dima = new THREE.Vector3(xDim, ay, zLine);
  const dimb = new THREE.Vector3(xDim, by, zLine);
  const label = new THREE.Vector3(xDim, (ay + by) / 2 + alongMm, zLine);
  return { ext1a, ext1b, ext2a, ext2b, dima, dimb, label };
}

/** When label sits outside the measured span, use inverted arrows + leader to text (ISO-style). */
function isoDimensionLayout(dim: DrawingSheetDimension) {
  const pts = isoDimensionWorldPoints(dim);
  const { ax, ay, bx, by, kind } = dim;
  const alongMm = dim.alongMm ?? 0;

  let leaderA: THREE.Vector3 | null = null;
  let leaderB: THREE.Vector3 | null = null;
  let invertArrows = false;

  if (kind === 'horizontal') {
    const yDim = Math.min(ay, by) - (dim.offsetMm ?? 0);
    const zLine = (dim.az + dim.bz) / 2;
    const xMin = Math.min(ax, bx);
    const xMax = Math.max(ax, bx);
    const xLabel = (ax + bx) / 2 + alongMm;
    const outside = xLabel - TEXT_HALF_ALONG_MM > xMax || xLabel + TEXT_HALF_ALONG_MM < xMin;
    if (outside) {
      invertArrows = true;
      if (xLabel > xMax) {
        leaderA = new THREE.Vector3(xMax, yDim, zLine);
        leaderB = new THREE.Vector3(xLabel, yDim, zLine);
      } else {
        leaderA = new THREE.Vector3(xMin, yDim, zLine);
        leaderB = new THREE.Vector3(xLabel, yDim, zLine);
      }
    }
  } else {
    const xDim = Math.max(ax, bx) + (dim.offsetMm ?? 0);
    const zLine = (dim.az + dim.bz) / 2;
    const yMin = Math.min(ay, by);
    const yMax = Math.max(ay, by);
    const yLabel = (ay + by) / 2 + alongMm;
    const outside = yLabel - TEXT_HALF_ALONG_MM > yMax || yLabel + TEXT_HALF_ALONG_MM < yMin;
    if (outside) {
      invertArrows = true;
      if (yLabel > yMax) {
        leaderA = new THREE.Vector3(xDim, yMax, zLine);
        leaderB = new THREE.Vector3(xDim, yLabel, zLine);
      } else {
        leaderA = new THREE.Vector3(xDim, yMin, zLine);
        leaderB = new THREE.Vector3(xDim, yLabel, zLine);
      }
    }
  }

  /** On-line anchor (along dimension); `labelPos` applies ISO 3098 placement (perpendicular offset + rotation). */
  const labelOnLine = pts.label;
  let labelPos: THREE.Vector3;
  let textRotationZ = 0;

  if (kind === 'horizontal') {
    // ISO 129-1: horizontal dimension figures parallel to the line, above the dimension line (+Y here).
    labelPos = new THREE.Vector3(labelOnLine.x, labelOnLine.y + ISO3098_LABEL_PERP_MM, labelOnLine.z);
  } else {
    // Vertical dimension: parallel to the line; place outside the silhouette (dimension line is +X of part).
    labelPos = new THREE.Vector3(labelOnLine.x + ISO3098_LABEL_PERP_MM, labelOnLine.y, labelOnLine.z);
    textRotationZ = Math.PI / 2;
  }

  return { ...pts, leaderA, leaderB, invertArrows, labelPos, textRotationZ };
}

function IsoDimensionLines({
  dim,
  highlight,
}: {
  dim: DrawingSheetDimension;
  highlight: 'none' | 'hover' | 'selected';
}) {
  const layout = useMemo(() => isoDimensionLayout(dim), [dim]);
  const pts = layout;

  const span = useMemo(
    () =>
      projectedSpanMm(
        dim.kind,
        new THREE.Vector3(dim.ax, dim.ay, dim.az),
        new THREE.Vector3(dim.bx, dim.by, dim.bz),
      ),
    [dim],
  );
  const text = `${span.toFixed(2)}`;

  const stroke = highlight === 'none' ? DIM_BLACK : DIM_ORANGE;
  const extOpacity = highlight === 'none' ? EXT_ALPHA : 1;

  const extGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array([
      pts.ext1a.x,
      pts.ext1a.y,
      pts.ext1a.z,
      pts.ext1b.x,
      pts.ext1b.y,
      pts.ext1b.z,
      pts.ext2a.x,
      pts.ext2a.y,
      pts.ext2a.z,
      pts.ext2b.x,
      pts.ext2b.y,
      pts.ext2b.z,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return g;
  }, [pts]);

  const dimGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const a = pts.dima;
    const b = pts.dimb;
    const parts: number[] = [a.x, a.y, a.z, b.x, b.y, b.z];
    if (pts.leaderA && pts.leaderB) {
      const la = pts.leaderA;
      const lb = pts.leaderB;
      parts.push(la.x, la.y, la.z, lb.x, lb.y, lb.z);
    }
    const arr = new Float32Array(parts);
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return g;
  }, [pts]);

  const dir = useMemo(() => new THREE.Vector3().subVectors(pts.dimb, pts.dima), [pts]);
  const len = dir.length();
  const dirN = useMemo(() => (len < 1e-9 ? null : dir.clone().normalize()), [dir, len]);

  const arrowGeoms = useMemo(() => {
    if (!dirN || len < 1e-9) return null;
    const { alen, aw } = effectiveArrowSizeMm(len);
    const s1 = pts.invertArrows ? -1 : 1;
    const s2 = pts.invertArrows ? 1 : -1;
    return {
      g1: arrowHeadGeometry(pts.dima, dirN, s1, alen, aw),
      g2: arrowHeadGeometry(pts.dimb, dirN, s2, alen, aw),
    };
  }, [pts, dirN, len]);

  useEffect(
    () => () => {
      extGeom.dispose();
      dimGeom.dispose();
      arrowGeoms?.g1.dispose();
      arrowGeoms?.g2.dispose();
    },
    [extGeom, dimGeom, arrowGeoms],
  );

  return (
    <group>
      <lineSegments geometry={extGeom} renderOrder={10}>
        <lineBasicMaterial
          color={stroke}
          transparent
          opacity={extOpacity}
          depthTest={false}
          depthWrite={false}
        />
      </lineSegments>
      <lineSegments geometry={dimGeom} renderOrder={10}>
        <lineBasicMaterial color={stroke} depthTest={false} depthWrite={false} />
      </lineSegments>
      {arrowGeoms && (
        <>
          <lineSegments geometry={arrowGeoms.g1} renderOrder={10}>
            <lineBasicMaterial color={stroke} depthTest={false} depthWrite={false} />
          </lineSegments>
          <lineSegments geometry={arrowGeoms.g2} renderOrder={10}>
            <lineBasicMaterial color={stroke} depthTest={false} depthWrite={false} />
          </lineSegments>
        </>
      )}
      <Text
        position={[pts.labelPos.x, pts.labelPos.y, pts.labelPos.z + 0.15]}
        rotation={[0, 0, pts.textRotationZ]}
        font={DIMENSION_FONT_URL}
        fontSize={TEXT_SCALE}
        letterSpacing={TEXT_SCALE * 0.05}
        color={stroke}
        anchorX="center"
        anchorY="middle"
        renderOrder={11}
        depthOffset={-0.02}
        material-depthTest={false}
        material-depthWrite={false}
        material-toneMapped={false}
      >
        {text}
      </Text>
    </group>
  );
}

/** Scale arrow length/width so heads fit on short dimensions but stay visible (was hidden when len < 4×ARROW_LEN). */
function effectiveArrowSizeMm(dimensionLineLenMm: number): { alen: number; aw: number } {
  const alen = Math.max(MIN_ARROW_MM, Math.min(ARROW_LEN, dimensionLineLenMm * 0.38));
  const aw = alen * (ARROW_W / ARROW_LEN);
  return { alen, aw };
}

function arrowHeadGeometry(
  tip: THREE.Vector3,
  along: THREE.Vector3,
  sign: number,
  arrowLen: number,
  arrowW: number,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const back = new THREE.Vector3().copy(tip).addScaledVector(along, sign * arrowLen);
  const side = new THREE.Vector3(-along.y, along.x, 0);
  if (side.lengthSq() < 1e-12) side.set(along.z, 0, -along.x);
  side.normalize().multiplyScalar(arrowW * 0.55);
  const p1 = new THREE.Vector3().copy(back).add(side);
  const p2 = new THREE.Vector3().copy(back).sub(side);
  const arr = new Float32Array([tip.x, tip.y, tip.z, p1.x, p1.y, p1.z, tip.x, tip.y, tip.z, p2.x, p2.y, p2.z]);
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return g;
}
