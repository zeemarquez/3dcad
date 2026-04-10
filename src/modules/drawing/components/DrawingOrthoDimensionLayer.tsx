import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { useDrawingStore } from '../store/useDrawingStore';
import type { DrawingDimensionMode, DrawingSheetDimension } from '../store/useDrawingStore';
import {
  isHorizontalInView,
  isVerticalInView,
  projectedSpanMm,
} from '../drawingDimensionMath';

const HOVER_PX = 10;
const DIM_BLACK = '#0a0a0a';
const DIM_ORANGE = '#ea580c';
const EXT_ALPHA = 0.85;
/** World-space mm; kept modest so labels stay readable without dominating the view. */
const ARROW_LEN = 1.05;
const ARROW_W = 0.38;
const TEXT_SCALE = 0.95;
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

function distToSeg2(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function clientToCanvasPx(e: PointerEvent, rect: DOMRect): { cx: number; cy: number } {
  return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
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
    const d = distanceToDimensionPick(dim, cx, cy, camera, w, h);
    if (d <= 14 && (!best || d < best.d)) {
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

function distanceToDimensionPick(
  dim: DrawingSheetDimension,
  cx: number,
  cy: number,
  camera: THREE.Camera,
  w: number,
  h: number,
): number {
  const pts = isoDimensionLayout(dim);
  const lines: [THREE.Vector3, THREE.Vector3][] = [
    [pts.ext1a, pts.ext1b],
    [pts.ext2a, pts.ext2b],
    [pts.dima, pts.dimb],
  ];
  if (pts.leaderA && pts.leaderB) lines.push([pts.leaderA, pts.leaderB]);
  let minD = Infinity;
  for (const [a, b] of lines) {
    const { ax, ay, bx, by } = projectSegmentToCanvas(a, b, camera, w, h);
    const d = distToSeg2(cx, cy, ax, ay, bx, by);
    if (d < minD) minD = d;
  }
  const mid = pts.labelPos.clone().project(camera);
  const lx = (mid.x * 0.5 + 0.5) * w;
  const ly = (-mid.y * 0.5 + 0.5) * h;
  minD = Math.min(minD, Math.hypot(cx - lx, cy - ly));
  return minD;
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
  const { camera, gl } = useThree();
  const setHoveredDimensionId = useDrawingStore((s) => s.setHoveredDimensionId);
  const setSelectedDimensionId = useDrawingStore((s) => s.setSelectedDimensionId);
  const selectedDimensionId = useDrawingStore((s) => s.selectedDimensionId);

  const segments = useMemo(() => buildWorldEdgeSegments(solids, q, offset), [solids, q, offset]);
  const [hoverEdgeIndex, setHoverEdgeIndex] = useState<number | null>(null);
  const hoverEdgeIndexRef = useRef<number | null>(null);

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

  useEffect(() => {
    const el = gl.domElement;

    const onMove = (e: PointerEvent) => {
      if (dragRef.current) return;
      const rect = el.getBoundingClientRect();
      const { cx, cy } = clientToCanvasPx(e, rect);
      const w = rect.width;
      const h = rect.height;

      const dimUnder = pickDimensionIdAt(dimensions, cx, cy, camera, w, h);
      setHoveredDimensionId(dimUnder);

      if (dimUnder) {
        hoverEdgeIndexRef.current = null;
        setHoverEdgeIndex(null);
        return;
      }

      if (!dimensionMode) {
        return;
      }

      let bestI: number | null = null;
      let bestD = HOVER_PX + 1;

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const { ax, ay, bx, by } = projectSegmentToCanvas(seg.a, seg.b, camera, w, h);
        const d = distToSeg2(cx, cy, ax, ay, bx, by);
        if (d < bestD && d <= HOVER_PX) {
          const ok =
            dimensionMode === 'horizontal'
              ? isHorizontalInView(seg.a, seg.b)
              : isVerticalInView(seg.a, seg.b);
          if (ok) {
            bestD = d;
            bestI = i;
          }
        }
      }
      hoverEdgeIndexRef.current = bestI;
      setHoverEdgeIndex((prev) => (prev === bestI ? prev : bestI));
    };

    const onLeave = () => {
      setHoveredDimensionId(null);
      hoverEdgeIndexRef.current = null;
      setHoverEdgeIndex(null);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const { cx, cy } = clientToCanvasPx(e, rect);
      const w = rect.width;
      const h = rect.height;

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
          viewWidthPx: w,
          viewHeightPx: h,
          viewSpanMm: (camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom,
          viewSpanXMm: (camera as THREE.OrthographicCamera).right - (camera as THREE.OrthographicCamera).left,
          kind: dim.kind,
        };
        el.setPointerCapture(e.pointerId);
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      if (dimensionMode) {
        let hi = hoverEdgeIndexRef.current;
        if (hi == null) {
          hi = pickStraightEdgeIndexAt(segments, cx, cy, camera, w, h, dimensionMode);
        }
        if (hi == null) return;
        const seg = segments[hi];
        const span = projectedSpanMm(dimensionMode, seg.a, seg.b);
        if (span < 1e-6) return;
        const ortho = camera as THREE.OrthographicCamera;
        const defaultOff = Math.min(14, (ortho.top - ortho.bottom) * 0.06);
        onAddDimension({
          viewId,
          kind: dimensionMode,
          ax: seg.a.x,
          ay: seg.a.y,
          az: seg.a.z,
          bx: seg.b.x,
          by: seg.b.y,
          bz: seg.b.z,
          offsetMm: defaultOff,
          alongMm: 0,
        });
        e.stopPropagation();
        e.preventDefault();
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
      const rect = el.getBoundingClientRect();
      const { cx, cy } = clientToCanvasPx(e, rect);
      const w = rect.width;
      const h = rect.height;
      const dimUnder = pickDimensionIdAt(dimensions, cx, cy, camera, w, h);
      if (!dimUnder) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedDimensionId(dimUnder);
      onDimensionContextMenu({ dimensionId: dimUnder, clientX: e.clientX, clientY: e.clientY });
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('pointermove', onMoveDrag);
    window.addEventListener('pointerup', onUpDrag);
    window.addEventListener('pointercancel', onUpDrag);

    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointermove', onMoveDrag);
      window.removeEventListener('pointerup', onUpDrag);
      window.removeEventListener('pointercancel', onUpDrag);
    };
  }, [
    camera,
    gl,
    dimensionMode,
    dimensions,
    onAddDimension,
    onUpdateDimensionGeometry,
    onDimensionContextMenu,
    segments,
    setHoveredDimensionId,
    setSelectedDimensionId,
    viewId,
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

  const hoveredDimensionId = useDrawingStore((s) => s.hoveredDimensionId);

  return (
    <>
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
    if (!dirN || len < ARROW_LEN * 4) return null;
    const s1 = pts.invertArrows ? -1 : 1;
    const s2 = pts.invertArrows ? 1 : -1;
    return {
      g1: arrowHeadGeometry(pts.dima, dirN, s1),
      g2: arrowHeadGeometry(pts.dimb, dirN, s2),
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

function arrowHeadGeometry(tip: THREE.Vector3, along: THREE.Vector3, sign: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const back = new THREE.Vector3().copy(tip).addScaledVector(along, sign * ARROW_LEN);
  const side = new THREE.Vector3(-along.y, along.x, 0);
  if (side.lengthSq() < 1e-12) side.set(along.z, 0, -along.x);
  side.normalize().multiplyScalar(ARROW_W * 0.55);
  const p1 = new THREE.Vector3().copy(back).add(side);
  const p2 = new THREE.Vector3().copy(back).sub(side);
  const arr = new Float32Array([tip.x, tip.y, tip.z, p1.x, p1.y, p1.z, tip.x, tip.y, tip.z, p2.x, p2.y, p2.z]);
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return g;
}
