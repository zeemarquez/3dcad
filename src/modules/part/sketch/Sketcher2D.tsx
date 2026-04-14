import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useCadStore, type SketchFeature } from '@/modules/part/store/useCadStore';
import {
  useSketchStore,
  type SelectionItem,
  type SketchLine,
  type SketchArc,
  type SketchBspline,
  SKETCH_REF_X_AXIS_ID,
  SKETCH_REF_Y_AXIS_ID,
} from '@/modules/part/store/useSketchStore';
import { initCAD, isCADReady, buildSectionSketchOverlay2D } from '@/modules/part/kernel/cadEngine';
import { sampleArcPoints, segmentCrossesPositiveXAxis } from '@/core/sketchArcPoints';
import {
  BSPLINE_DEFAULT_DEGREE,
  BSPLINE_DEFAULT_SAMPLES_PER_SPAN,
  BSPLINE_HIT_SAMPLES_PER_SPAN,
  sampleOpenUniformBSpline,
} from '@/core/sketchBspline';
import { mergeCoincidentSketchVertices, pickNextEdgeInFace, snapClosedPolyline } from '@/core/sketchLoopDetection';

/** World snap cursor position; `snapped` is set when the cursor locked to an existing sketch point (see `snapWorld`). */
type SketchDrawSnap = { x: number; y: number; snapped?: string | null };
import { featuresToCadFeatureInputs } from '@/modules/part/kernel/cadFeatureInputs';
import { computeSketchDoFState, type SketchDoFState } from '@/core/sketchDoF';

function evaluateInputExpression(
  raw: string,
  env: Record<string, number>,
  selfName?: string
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: 'Value is required' };
  if (!trimmed.startsWith('=')) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { ok: false, message: 'Invalid numeric value' };
    return { ok: true, value: n };
  }
  const body = trimmed.slice(1).trim();
  if (!body) return { ok: false, message: 'Expression is empty' };
  if (selfName) {
    const selfRef = new RegExp(`\\b${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (selfRef.test(body)) return { ok: false, message: 'Self reference is not allowed' };
  }
  let unknown: string | null = null;
  const replaced = body.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (token) => {
    if (Object.prototype.hasOwnProperty.call(env, token)) return String(env[token]);
    unknown = token;
    return token;
  });
  if (unknown) return { ok: false, message: `Unknown parameter: ${unknown}` };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${replaced});`);
    const result = Number(fn());
    if (!Number.isFinite(result)) return { ok: false, message: 'Expression result is not finite' };
    return { ok: true, value: result };
  } catch {
    return { ok: false, message: 'Invalid expression' };
  }
}

const COLORS = {
  bg: '#f8fafc',
  /** Existing solid bodies ∩ sketch plane — drawn behind grid/entities */
  solidSection: '#ede9fe',
  solidSectionEdge: '#a78bfa',
  grid: '#d4d4d8',
  gridMajor: '#a1a1aa',
  axisX: '#ef4444',
  axisY: '#22c55e',
  entity: '#60a5fa',
  entityHover: '#93c5fd',
  entitySelected: '#fbbf24',
  temp: '#6b7280',
  point: '#60a5fa',
  pointHover: '#93c5fd',
  pointSelected: '#fbbf24',
  constraint: '#3b82f6',
  constrained: '#22c55e',
  origin: '#52525b',
};

const DIMENSION_TYPES = new Set([
  'length',
  'horizontalDistance',
  'verticalDistance',
  'radius',
  'angle',
  'distance',
]);

/** Degrees — cursor within this angle of horizontal/vertical from anchor snaps orthogonally while drawing lines. */
const LINE_ANCHOR_ORTHO_SNAP_DEG = 6;

/**
 * Snap (wx, wy) to horizontal or vertical through (ax, ay) when within maxAngleDeg of that axis.
 * When both axes qualify (e.g. near 45°), picks the closer alignment.
 */
function snapLineEndpointToAnchorOrtho(
  ax: number,
  ay: number,
  wx: number,
  wy: number,
  maxAngleDeg: number
): { x: number; y: number; mode: 'horizontal' | 'vertical' | null } {
  const dx = wx - ax;
  const dy = wy - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return { x: wx, y: wy, mode: null };
  const thr = (maxAngleDeg * Math.PI) / 180;
  const sinThr = Math.sin(thr);
  const sinFromH = Math.abs(dy) / len;
  const sinFromV = Math.abs(dx) / len;
  const nearH = sinFromH <= sinThr;
  const nearV = sinFromV <= sinThr;
  if (nearH && nearV) {
    return sinFromH <= sinFromV
      ? { x: wx, y: ay, mode: 'horizontal' }
      : { x: ax, y: wy, mode: 'vertical' };
  }
  if (nearH) return { x: wx, y: ay, mode: 'horizontal' };
  if (nearV) return { x: ax, y: wy, mode: 'vertical' };
  return { x: wx, y: wy, mode: null };
}

/** If endpoints form a horizontal or vertical segment, apply the matching constraint (single history entry). */
function applyHorizontalOrVerticalConstraintToLine(lineId: string, p1Id: string, p2Id: string) {
  const st = useSketchStore.getState();
  const p1 = st.points.find((p) => p.id === p1Id);
  const p2 = st.points.find((p) => p.id === p2Id);
  if (!p1 || !p2) return;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-10) return;
  const angTol = 1e-9;
  const horiz = Math.abs(dy) / len < angTol;
  const vert = Math.abs(dx) / len < angTol;
  if (horiz === vert) return;
  st.clearSelection();
  st.toggleSelect({ type: 'line', id: lineId }, false);
  st.applyConstraint(horiz ? 'horizontal' : 'vertical', { skipHistory: true });
  st.clearSelection();
}

interface Loop2D {
  id: string;
  pts: { x: number; y: number }[];
  areaAbs: number;
  centroid: { x: number; y: number };
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

interface LoopEdge {
  id: string;
  a: string;
  b: string;
  path: { x: number; y: number }[]; // includes both endpoints
}

function signedArea(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return 0.5 * a;
}

function computeLoopMeta(pts: { x: number; y: number }[], id: string): Loop2D | null {
  if (pts.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let cx = 0, cy = 0;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    cx += p.x; cy += p.y;
  }
  const a = Math.abs(signedArea(pts));
  if (a < 1e-8) return null;
  return {
    id,
    pts,
    areaAbs: a,
    centroid: { x: cx / pts.length, y: cy / pts.length },
    bbox: { minX, minY, maxX, maxY },
  };
}

function pointInPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersects = ((yi > p.y) !== (yj > p.y))
      && (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Point IDs to move when dragging a curve by its body (not a vertex). */
function getPointIdsForEntityDrag(
  entity: SelectionItem,
  lines: SketchLine[],
  arcs: SketchArc[],
  bsplines: SketchBspline[]
): string[] | null {
  if (entity.type === 'line') {
    if (entity.id === SKETCH_REF_X_AXIS_ID || entity.id === SKETCH_REF_Y_AXIS_ID) return null;
    const line = lines.find((l) => l.id === entity.id);
    if (!line) return null;
    return [line.p1Id, line.p2Id];
  }
  if (entity.type === 'arc') {
    const a = arcs.find((x) => x.id === entity.id);
    if (!a) return null;
    return [a.centerId, a.startId, a.endId];
  }
  if (entity.type === 'bspline') {
    const b = bsplines.find((x) => x.id === entity.id);
    if (!b) return null;
    return [...b.controlPointIds];
  }
  return null;
}

export const Sketcher2D: React.FC = () => {
  const activeModule = useCadStore((s) => s.activeModule);
  const activeCommand = useCadStore((s) => s.activeCommand);
  const setActiveCommand = useCadStore((s) => s.setActiveCommand);
  const features = useCadStore((s) => s.features);
  const activeSketchId = useCadStore((s) => s.activeSketchId);
  const userParameters = useCadStore((s) => s.userParameters);
  const dimensionParameters = useCadStore((s) => s.dimensionParameters);

  const {
    points,
    lines,
    circles,
    arcs,
    bsplines,
    constraints,
    selection,
    statusMessage,
    addPoint,
    addLine,
    addCircle,
    setCircleRadius,
    addArc,
    addBspline,
    applyConstraint,
    addCoincidentBetweenPoints,
    toggleSelect,
    clearSelection,
    deleteSelected,
    toggleAuxiliarySelected,
    findNearestPoint,
    findNearestEntity,
    setStatusMessage,
    dragPoint,
    finalizeDrag,
    translateSketchPoints,
    pendingConstraintType,
    clearPendingConstraintSelection,
    pendingDimensionInput,
    submitDimensionInput,
    cancelDimensionInput,
    requestEditDimension,
    updateConstraintParams,
    pushSketchHistory,
    undoSketch,
    redoSketch,
  } = useSketchStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  // View state
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [zoom, setZoom] = useState(40);

  // Panning
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const [draggingPointId, setDraggingPointId] = useState<string | null>(null);
  /** Same as draggingPointId but updated synchronously so pointermove sees it before the next render (matches entityDragRef). */
  const draggingPointIdRef = useRef<string | null>(null);
  const entityDragRef = useRef<{ pointIds: string[]; lastX: number; lastY: number } | null>(null);
  const [isDraggingEntity, setIsDraggingEntity] = useState(false);
  const circleRadiusDragRef = useRef<{ circleId: string } | null>(null);
  const [isDraggingCircleRadius, setIsDraggingCircleRadius] = useState(false);
  const dofCacheRef = useRef<SketchDoFState>({
    pointDoF: new Map(),
    lineDoF: new Map(),
    arcDoF: new Map(),
    circleDoF: new Map(),
    isSketchFullyConstrained: false,
  });

  // Drawing state
  const [drawPts, setDrawPts] = useState<SketchDrawSnap[]>([]);
  /** While placing arc third point: Shift = complementary (longer) arc branch. */
  const [arcShiftHeld, setArcShiftHeld] = useState(false);
  /** Toggled when the cursor segment crosses the +x ray from arc center (0°), not at the atan2 ±π seam. */
  const [arcAutoComplementary, setArcAutoComplementary] = useState(false);
  const arcPrevCursorLocalRef = useRef<{ x: number; y: number } | null>(null);
  /** Synchronous gate: sweep toggling (Shift / +x crossing) only while placing the third arc point — not after commit (avoids stale pointermove). */
  const arcThirdPointPlacementActiveRef = useRef(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [snappedCursor, setSnappedCursor] = useState({ x: 0, y: 0 });
  const [snapIndicator, setSnapIndicator] = useState<string | null>(null);
  const [hoveredEntity, setHoveredEntity] = useState<SelectionItem | null>(null);
  const [dimensionValue, setDimensionValue] = useState('');
  const [dimensionInputError, setDimensionInputError] = useState('');
  const [dimSuggestOpen, setDimSuggestOpen] = useState(false);
  const [dimSuggestIdx, setDimSuggestIdx] = useState(0);
  const [draggingDimension, setDraggingDimension] = useState<{
    id: string;
    startX: number;
    startY: number;
    baseDx: number;
    baseDy: number;
    axisX: number;
    axisY: number;
    /** Circle radius: drag sets `radiusDimAngle` from cursor vs center (rotation about center). */
    radiusCircleRotate?: boolean;
  } | null>(null);

  const [sketchContextMenu, setSketchContextMenu] = useState<{
    x: number;
    y: number;
    item: SelectionItem;
  } | null>(null);
  const sketchMenuRef = useRef<HTMLDivElement>(null);
  const [boxSelect, setBoxSelect] = useState<{
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    additive: boolean;
  } | null>(null);
  const boxSelectStartRef = useRef<{
    sx: number;
    sy: number;
    startMs: number;
    additive: boolean;
    pointerId: number;
  } | null>(null);

  const snapEnabled = true;
  const gridSnap = 0.5;
  /** World-space radius matching `snapWorld` (8 screen px) — used to detect nearby points for coincident. */
  const worldSnapThreshold = Math.max(1e-12, 8 / zoom);

  /** New sketch vertex at (x,y); if snapped to or near an existing point, adds a real coincident constraint (◉). */
  const placeSketchPoint = useCallback(
    (x: number, y: number, cursorSnappedId: string | null | undefined) => {
      let existingId: string | null = null;
      if (cursorSnappedId) {
        existingId = cursorSnappedId;
      } else {
        existingId = findNearestPoint(x, y, worldSnapThreshold);
      }
      const newId = addPoint(x, y);
      if (existingId && existingId !== newId) {
        addCoincidentBetweenPoints(newId, existingId, { skipHistory: true });
      }
      return newId;
    },
    [findNearestPoint, addPoint, worldSnapThreshold, addCoincidentBetweenPoints]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setDims({ w: el.clientWidth, h: el.clientHeight });
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) {
        setDims({ w: e.contentRect.width, h: e.contentRect.height });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [activeModule]);

  const screenToWorld = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - dims.w / 2 - panX) / zoom,
      y: -(sy - dims.h / 2 - panY) / zoom,
    }),
    [dims.w, dims.h, panX, panY, zoom]
  );

  const worldToScreen = useCallback(
    (wx: number, wy: number) => ({
      x: wx * zoom + dims.w / 2 + panX,
      y: -wy * zoom + dims.h / 2 + panY,
    }),
    [dims.w, dims.h, panX, panY, zoom]
  );

  const snapWorld = useCallback(
    (wx: number, wy: number): { x: number; y: number; snapped: string | null } => {
      if (!snapEnabled) return { x: wx, y: wy, snapped: null };
      const threshold = 8 / zoom;
      const nearPt = findNearestPoint(wx, wy, threshold);
      if (nearPt) {
        const pt = useSketchStore.getState().points.find((p) => p.id === nearPt);
        if (pt) return { x: pt.x, y: pt.y, snapped: nearPt };
      }
      const gx = Math.round(wx / gridSnap) * gridSnap;
      const gy = Math.round(wy / gridSnap) * gridSnap;
      return { x: gx, y: gy, snapped: null };
    },
    [zoom, findNearestPoint]
  );

  /** Grid + point snap, then ortho from line/polyline anchor when drawing a segment (preview + click). */
  const snapWorldForLineDraw = useCallback(
    (wx: number, wy: number) => {
      const base = snapWorld(wx, wy);
      const anchorLine =
        activeCommand === 'line' && drawPts.length === 1 ? drawPts[0] : null;
      const anchorPoly =
        activeCommand === 'polyline' && drawPts.length >= 1 ? drawPts[drawPts.length - 1] : null;
      const anchor = anchorLine ?? anchorPoly;
      if (!anchor) return base;
      if (base.snapped) return base;
      const o = snapLineEndpointToAnchorOrtho(anchor.x, anchor.y, base.x, base.y, LINE_ANCHOR_ORTHO_SNAP_DEG);
      if (o.mode === null) return base;
      return { x: o.x, y: o.y, snapped: base.snapped };
    },
    [snapWorld, activeCommand, drawPts]
  );

  const isDrawingTool = (cmd: string | null) =>
    cmd === 'line' ||
    cmd === 'polyline' ||
    cmd === 'circle' ||
    cmd === 'arc' ||
    cmd === 'rectangle' ||
    cmd === 'bspline';
  const isMultiSelectEvent = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
    e.shiftKey || e.ctrlKey || e.metaKey;
  const isProtectedOriginFixConstraint = useCallback(
    (c: { type: string; entityIds: string[]; params?: Record<string, number> }) => {
      if (c.type !== 'fix' || c.entityIds.length !== 1) return false;
      if (Number(c.params?.x) !== 0 || Number(c.params?.y) !== 0) return false;
      const pt = points.find((p) => p.id === c.entityIds[0]);
      if (!pt) return false;
      return Math.abs(pt.x) < 1e-9 && Math.abs(pt.y) < 1e-9;
    },
    [points]
  );

  const collectBoxSelection = useCallback(
    (sx1: number, sy1: number, sx2: number, sy2: number, additive: boolean) => {
      const a = screenToWorld(sx1, sy1);
      const b = screenToWorld(sx2, sy2);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;

      const inBox: SelectionItem[] = [];
      for (const p of points) {
        if (inside(p.x, p.y)) inBox.push({ type: 'point', id: p.id });
      }
      for (const l of lines) {
        const p1 = points.find((p) => p.id === l.p1Id);
        const p2 = points.find((p) => p.id === l.p2Id);
        if (p1 && p2 && inside(p1.x, p1.y) && inside(p2.x, p2.y)) {
          inBox.push({ type: 'line', id: l.id });
        }
      }
      for (const c of circles) {
        const center = points.find((p) => p.id === c.centerId);
        if (!center) continue;
        if (
          center.x - c.radius >= minX &&
          center.x + c.radius <= maxX &&
          center.y - c.radius >= minY &&
          center.y + c.radius <= maxY
        ) {
          inBox.push({ type: 'circle', id: c.id });
        }
      }
      for (const aItem of arcs) {
        const c = points.find((p) => p.id === aItem.centerId);
        const s = points.find((p) => p.id === aItem.startId);
        const e = points.find((p) => p.id === aItem.endId);
        if (!c || !s || !e) continue;
        const samples = sampleArcPoints(
          { x: c.x, y: c.y },
          { x: s.x, y: s.y },
          { x: e.x, y: e.y },
          Math.PI / 36,
          { complementaryArc: !!aItem.complementaryArc }
        );
        if (samples.every((pt) => inside(pt.x, pt.y))) {
          inBox.push({ type: 'arc', id: aItem.id });
        }
      }
      for (const bItem of bsplines) {
        const deg = bItem.degree ?? BSPLINE_DEFAULT_DEGREE;
        const ctrl = bItem.controlPointIds
          .map((pid) => points.find((p) => p.id === pid))
          .filter((p): p is NonNullable<typeof p> => !!p);
        if (ctrl.length !== bItem.controlPointIds.length || ctrl.length < deg + 1) continue;
        const samples = sampleOpenUniformBSpline(ctrl, deg, BSPLINE_HIT_SAMPLES_PER_SPAN);
        if (samples.every((pt) => inside(pt.x, pt.y))) {
          inBox.push({ type: 'bspline', id: bItem.id });
        }
      }
      const labels: Record<string, string> = {
        fix: 'FIX',
        coincident: '◉',
        horizontal: 'H',
        vertical: 'V',
        equal: '=',
        parallel: '∥',
        perpendicular: '⊥',
        tangent: 'T',
        concentric: '⊙',
        midpoint: 'M',
        pointOnLine: '⊕',
        symmetry: '⇄',
      };
      for (const c of constraints) {
        if (
          c.type === 'arcRadius' ||
          DIMENSION_TYPES.has(c.type) ||
          !labels[c.type] ||
          isProtectedOriginFixConstraint(c)
        ) continue;
        const line = lines.find((l) => l.id === c.entityIds[0]);
        if (line) {
          const p1 = points.find((p) => p.id === line.p1Id);
          const p2 = points.find((p) => p.id === line.p2Id);
          if (!p1 || !p2) continue;
          const cx = (p1.x + p2.x) / 2;
          const cy = (p1.y + p2.y) / 2;
          if (inside(cx, cy)) inBox.push({ type: 'constraint', id: c.id });
          continue;
        }
        const pt = points.find((p) => p.id === c.entityIds[0]);
        if (pt && inside(pt.x, pt.y)) inBox.push({ type: 'constraint', id: c.id });
      }

      const uniq = new Map<string, SelectionItem>();
      for (const item of inBox) {
        uniq.set(`${item.type}:${item.id}`, item);
      }
      const boxed = [...uniq.values()];
      if (additive) {
        const existing = useSketchStore.getState().selection;
        const merged = new Map<string, SelectionItem>();
        for (const item of existing) merged.set(`${item.type}:${item.id}`, item);
        for (const item of boxed) merged.set(`${item.type}:${item.id}`, item);
        useSketchStore.setState({ selection: [...merged.values()] });
      } else {
        useSketchStore.setState({ selection: boxed });
      }
    },
    [screenToWorld, points, lines, circles, arcs, bsplines, constraints, isProtectedOriginFixConstraint]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        setIsPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
        (e.target as Element).setPointerCapture?.(e.pointerId);
        return;
      }

      if (e.button !== 0) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const snap =
        (activeCommand === 'line' && drawPts.length >= 1) ||
        (activeCommand === 'polyline' && drawPts.length >= 1)
          ? snapWorldForLineDraw(world.x, world.y)
          : snapWorld(world.x, world.y);
      const tryApplyPendingConstraint = () => {
        const pending = useSketchStore.getState().pendingConstraintType;
        if (!pending) return;
        const res = useSketchStore.getState().applyConstraint(pending);
        if (res.success) {
          useSketchStore.getState().clearPendingConstraintSelection();
          useSketchStore.getState().clearSelection();
        }
      };

      if (!isDrawingTool(activeCommand)) {
        const multiSelect = isMultiSelectEvent(e);
        const labels: Record<string, string> = {
          fix: 'FIX',
          coincident: '◉',
          horizontal: 'H',
          vertical: 'V',
          equal: '=',
          parallel: '∥',
          perpendicular: '⊥',
          tangent: 'T',
          concentric: '⊙',
          midpoint: 'M',
          pointOnLine: '⊕',
          symmetry: '⇄',
        };
        const clickedConstraint = pendingConstraintType ? undefined : constraints
          .filter((c) => c.type !== 'arcRadius' && !DIMENSION_TYPES.has(c.type) && !!labels[c.type] && !isProtectedOriginFixConstraint(c))
          .map((c) => {
            let cx = 0;
            let cy = 0;
            const line = lines.find((l) => l.id === c.entityIds[0]);
            if (line) {
              const p1 = points.find((p) => p.id === line.p1Id);
              const p2 = points.find((p) => p.id === line.p2Id);
              if (p1 && p2) {
                cx = (p1.x + p2.x) / 2;
                cy = (p1.y + p2.y) / 2;
              }
            } else {
              const pt = points.find((p) => p.id === c.entityIds[0]);
              if (pt) {
                cx = pt.x;
                cy = pt.y;
              }
            }
            return { id: c.id, x: cx, y: cy };
          })
          .find((icon) => {
          const screen = worldToScreen(icon.x, icon.y);
          const cx = screen.x + 12;
          const cy = screen.y - 12;
          const dx = sx - cx;
          const dy = sy - cy;
          return dx * dx + dy * dy <= 10 * 10;
          });
        if (clickedConstraint) {
          toggleSelect({ type: 'constraint', id: clickedConstraint.id }, multiSelect);
          return;
        }

        const hitThreshold = 8 / zoom;
        const nearPointId = findNearestPoint(world.x, world.y, hitThreshold);
        if (nearPointId) {
          if (!pendingConstraintType) {
            entityDragRef.current = null;
            setIsDraggingEntity(false);
            circleRadiusDragRef.current = null;
            setIsDraggingCircleRadius(false);
            pushSketchHistory();
            draggingPointIdRef.current = nearPointId;
            setDraggingPointId(nearPointId);
          }
          toggleSelect({ type: 'point', id: nearPointId }, multiSelect);
          if (!pendingConstraintType) (e.target as Element).setPointerCapture?.(e.pointerId);
          tryApplyPendingConstraint();
          return;
        }
        const entity = findNearestEntity(world.x, world.y, hitThreshold);
        if (entity) {
          // Clicking a curve/line should select that entity directly.
          // Point dragging is only started when a point is explicitly hit.
          // Circle perimeter: resize radius; line/arc: translate body (circle center uses point hit above).
          if (!pendingConstraintType) {
            if (entity.type === 'circle' && circles.some((c) => c.id === entity.id)) {
              draggingPointIdRef.current = null;
              setDraggingPointId(null);
              entityDragRef.current = null;
              setIsDraggingEntity(false);
              pushSketchHistory();
              circleRadiusDragRef.current = { circleId: entity.id };
              setIsDraggingCircleRadius(true);
              (e.target as Element).setPointerCapture?.(e.pointerId);
            } else {
              const dragIds = getPointIdsForEntityDrag(entity, lines, arcs, bsplines);
              if (dragIds && dragIds.length > 0) {
                draggingPointIdRef.current = null;
                setDraggingPointId(null);
                circleRadiusDragRef.current = null;
                setIsDraggingCircleRadius(false);
                pushSketchHistory();
                entityDragRef.current = { pointIds: dragIds, lastX: world.x, lastY: world.y };
                setIsDraggingEntity(true);
                (e.target as Element).setPointerCapture?.(e.pointerId);
              }
            }
          }
          toggleSelect(entity, multiSelect);
          tryApplyPendingConstraint();
        } else {
          draggingPointIdRef.current = null;
          setDraggingPointId(null);
          entityDragRef.current = null;
          setIsDraggingEntity(false);
          circleRadiusDragRef.current = null;
          setIsDraggingCircleRadius(false);
          boxSelectStartRef.current = {
            sx,
            sy,
            startMs: performance.now(),
            additive: multiSelect,
            pointerId: e.pointerId,
          };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }
        return;
      }

      if (activeCommand === 'line') {
        if (drawPts.length === 0) {
          setDrawPts([snap]);
        } else {
          pushSketchHistory();
          const d0 = drawPts[0];
          const startId = placeSketchPoint(d0.x, d0.y, d0.snapped);
          const endId = placeSketchPoint(snap.x, snap.y, snap.snapped);
          const lineId = addLine(startId, endId);
          applyHorizontalOrVerticalConstraintToLine(lineId, startId, endId);
          setDrawPts([]);
        }
      } else if (activeCommand === 'polyline') {
        if (drawPts.length === 0) {
          setDrawPts([snap]);
        } else {
          pushSketchHistory();
          const prev = drawPts[drawPts.length - 1];
          const prevId = placeSketchPoint(prev.x, prev.y, prev.snapped);
          const endId = placeSketchPoint(snap.x, snap.y, snap.snapped);
          const lineId = addLine(prevId, endId);
          applyHorizontalOrVerticalConstraintToLine(lineId, prevId, endId);
          setDrawPts([...drawPts, snap]);
        }
      } else if (activeCommand === 'circle') {
        if (drawPts.length === 0) {
          setDrawPts([snap]);
        } else {
          const center = drawPts[0];
          const radius = Math.sqrt((snap.x - center.x) ** 2 + (snap.y - center.y) ** 2);
          if (radius > 0.01) {
            pushSketchHistory();
            const centerId = placeSketchPoint(center.x, center.y, center.snapped);
            addCircle(centerId, radius);
          }
          setDrawPts([]);
        }
      } else if (activeCommand === 'arc') {
        if (drawPts.length === 0) {
          arcThirdPointPlacementActiveRef.current = false;
          setDrawPts([snap]);
        } else if (drawPts.length === 1) {
          arcThirdPointPlacementActiveRef.current = true;
          setDrawPts([...drawPts, snap]);
        } else {
          arcThirdPointPlacementActiveRef.current = false;
          arcPrevCursorLocalRef.current = null;
          const center = drawPts[0];
          const startPt = drawPts[1];
          const radius = Math.sqrt((startPt.x - center.x) ** 2 + (startPt.y - center.y) ** 2);
          if (radius > 0.01) {
            pushSketchHistory();
            const angle = Math.atan2(snap.y - center.y, snap.x - center.x);
            const endX = center.x + radius * Math.cos(angle);
            const endY = center.y + radius * Math.sin(angle);

            const centerId = placeSketchPoint(center.x, center.y, center.snapped);
            const startId = placeSketchPoint(startPt.x, startPt.y, startPt.snapped);
            // Must snap end to an existing corner when it coincides (e.g. arc closes a rectangle
            // after deleting a side). A duplicate point id breaks the edge graph and region fill.
            const endId = placeSketchPoint(endX, endY, undefined);
            addArc(centerId, startId, endId, arcAutoComplementary !== e.shiftKey);
          }
          setDrawPts([]);
        }
      } else if (activeCommand === 'rectangle') {
        if (drawPts.length === 0) {
          setDrawPts([snap]);
        } else {
          const c1 = drawPts[0];
          const c2 = snap;
          if (Math.abs(c2.x - c1.x) > 0.01 && Math.abs(c2.y - c1.y) > 0.01) {
            pushSketchHistory();
            const p1 = placeSketchPoint(c1.x, c1.y, c1.snapped);
            const p2 = placeSketchPoint(c2.x, c1.y, undefined);
            const p3 = placeSketchPoint(c2.x, c2.y, c2.snapped);
            const p4 = placeSketchPoint(c1.x, c2.y, undefined);
            const l1 = addLine(p1, p2);
            const l2 = addLine(p2, p3);
            const l3 = addLine(p3, p4);
            const l4 = addLine(p4, p1);

            // Auto-constrain rectangle sides: top/bottom horizontal, left/right vertical.
            clearSelection();
            toggleSelect({ type: 'line', id: l1 }, false);
            applyConstraint('horizontal', { skipHistory: true });
            toggleSelect({ type: 'line', id: l3 }, false);
            applyConstraint('horizontal', { skipHistory: true });
            toggleSelect({ type: 'line', id: l2 }, false);
            applyConstraint('vertical', { skipHistory: true });
            toggleSelect({ type: 'line', id: l4 }, false);
            applyConstraint('vertical', { skipHistory: true });
            clearSelection();
          }
          setDrawPts([]);
        }
      } else if (activeCommand === 'bspline') {
        setDrawPts((prev) => [...prev, snap]);
      }
    },
    [
      activeCommand,
      drawPts,
      panX,
      panY,
      zoom,
      screenToWorld,
      worldToScreen,
      snapWorld,
      snapWorldForLineDraw,
      addPoint,
      addLine,
      addCircle,
      addArc,
      applyConstraint,
      placeSketchPoint,
      findNearestPoint,
      findNearestEntity,
      constraints,
      isProtectedOriginFixConstraint,
      pendingConstraintType,
      lines,
      circles,
      arcs,
      bsplines,
      points,
      isMultiSelectEvent,
      toggleSelect,
      clearSelection,
      clearPendingConstraintSelection,
      arcAutoComplementary,
      pushSketchHistory,
    ]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (isPanning) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        setPanX(panStartRef.current.px + dx);
        setPanY(panStartRef.current.py + dy);
        return;
      }

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      setCursor(world);
      const snap =
        (activeCommand === 'line' && drawPts.length >= 1) ||
        (activeCommand === 'polyline' && drawPts.length >= 1)
          ? snapWorldForLineDraw(world.x, world.y)
          : snapWorld(world.x, world.y);
      setSnappedCursor(snap);
      setSnapIndicator(snap.snapped);

      if (
        activeCommand === 'arc' &&
        drawPts.length === 2 &&
        arcThirdPointPlacementActiveRef.current
      ) {
        setArcShiftHeld(e.shiftKey);
        const center = drawPts[0];
        const lx = snap.x - center.x;
        const ly = snap.y - center.y;
        const prev = arcPrevCursorLocalRef.current;
        if (prev && (Math.abs(lx) > 1e-12 || Math.abs(ly) > 1e-12)) {
          if (segmentCrossesPositiveXAxis(prev.x, prev.y, lx, ly)) {
            setArcAutoComplementary((c) => !c);
          }
        }
        arcPrevCursorLocalRef.current = { x: lx, y: ly };
      }

      if (draggingDimension) {
        if (draggingDimension.radiusCircleRotate) {
          const { constraints: cList, circles: circList, points: ptList } = useSketchStore.getState();
          const cn = cList.find((cc) => cc.id === draggingDimension.id);
          const eid = cn?.entityIds[0];
          const circ = eid ? circList.find((ci) => ci.id === eid) : undefined;
          const center = circ ? ptList.find((p) => p.id === circ.centerId) : undefined;
          if (center) {
            const ang = Math.atan2(world.y - center.y, world.x - center.x);
            updateConstraintParams(draggingDimension.id, { radiusDimAngle: ang });
          }
          return;
        }
        const ddx = world.x - draggingDimension.startX;
        const ddy = world.y - draggingDimension.startY;
        // Constrain drag to dimension's single degree of freedom.
        const t = ddx * draggingDimension.axisX + ddy * draggingDimension.axisY;
        const cdx = draggingDimension.axisX * t;
        const cdy = draggingDimension.axisY * t;
        updateConstraintParams(draggingDimension.id, {
          labelDx: draggingDimension.baseDx + cdx,
          labelDy: draggingDimension.baseDy + cdy,
        });
        return;
      }

      // Point drag must run before entity/circle drags: stale entity/circle refs from a missed
      // pointerup would otherwise block vertex/center drags for the whole session.
      const pointDragId = draggingPointIdRef.current;
      if (pointDragId) {
        dragPoint(pointDragId, world.x, world.y);
        return;
      }

      const entityDrag = entityDragRef.current;
      if (entityDrag) {
        const dx = world.x - entityDrag.lastX;
        const dy = world.y - entityDrag.lastY;
        entityDrag.lastX = world.x;
        entityDrag.lastY = world.y;
        translateSketchPoints(entityDrag.pointIds, dx, dy);
        return;
      }

      const crDrag = circleRadiusDragRef.current;
      if (crDrag) {
        const { circles: cList, points: ptList } = useSketchStore.getState();
        const circ = cList.find((c) => c.id === crDrag.circleId);
        const center = circ ? ptList.find((p) => p.id === circ.centerId) : undefined;
        if (circ && center) {
          const r = Math.hypot(world.x - center.x, world.y - center.y);
          setCircleRadius(crDrag.circleId, r);
        }
        return;
      }

      const pendingBox = boxSelectStartRef.current;
      if (pendingBox) {
        const dx = sx - pendingBox.sx;
        const dy = sy - pendingBox.sy;
        const movedPx = Math.hypot(dx, dy);
        const elapsedMs = performance.now() - pendingBox.startMs;
        const shouldActivate = elapsedMs >= 180 && movedPx >= 4;
        if (boxSelect || shouldActivate) {
          const next = {
            startX: pendingBox.sx,
            startY: pendingBox.sy,
            curX: sx,
            curY: sy,
            additive: pendingBox.additive,
          };
          if (!boxSelect) setBoxSelect(next);
          else setBoxSelect({ ...boxSelect, curX: sx, curY: sy });
          collectBoxSelection(next.startX, next.startY, next.curX, next.curY, next.additive);
          setHoveredEntity(null);
          return;
        }
      }

      if (!isDrawingTool(activeCommand)) {
        const hitThreshold = 8 / zoom;
        const entity = findNearestEntity(world.x, world.y, hitThreshold);
        setHoveredEntity(entity);
      }
    },
    [isPanning, screenToWorld, snapWorld, snapWorldForLineDraw, draggingDimension, updateConstraintParams, dragPoint, translateSketchPoints, setCircleRadius, boxSelect, collectBoxSelection, activeCommand, drawPts, zoom, findNearestEntity]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (isPanning) {
        setIsPanning(false);
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      }
      if (draggingPointIdRef.current) {
        draggingPointIdRef.current = null;
        setDraggingPointId(null);
        finalizeDrag();
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      }
      if (entityDragRef.current) {
        entityDragRef.current = null;
        setIsDraggingEntity(false);
        finalizeDrag();
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      }
      if (circleRadiusDragRef.current) {
        circleRadiusDragRef.current = null;
        setIsDraggingCircleRadius(false);
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      }
      if (draggingDimension) {
        setDraggingDimension(null);
      }
      if (boxSelectStartRef.current?.pointerId === e.pointerId) {
        if (boxSelect) {
          collectBoxSelection(boxSelect.startX, boxSelect.startY, boxSelect.curX, boxSelect.curY, boxSelect.additive);
          setBoxSelect(null);
        } else if (!boxSelectStartRef.current.additive) {
          clearSelection();
        }
        boxSelectStartRef.current = null;
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      }
    },
    [isPanning, draggingDimension, boxSelect, collectBoxSelection, clearSelection, finalizeDrag]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent | WheelEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const worldBefore = screenToWorld(sx, sy);
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(2, Math.min(500, zoom * factor));

      const newPanX = sx - dims.w / 2 - worldBefore.x * newZoom;
      const newPanY = sy - dims.h / 2 + worldBefore.y * newZoom;

      setZoom(newZoom);
      setPanX(newPanX);
      setPanY(newPanY);
    },
    [zoom, dims, screenToWorld]
  );

  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;

  // React's onWheel is passive in practice, so preventDefault() does not stop browser zoom
  // (Ctrl+wheel / trackpad pinch). A non-passive native listener is required.
  // Re-attach when entering sketch mode: on first mount we often render `null` (part module),
  // so containerRef is null and a []-only effect would never register the listener.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handleWheelRef.current(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [activeModule]);

  const finalizeBsplineDraw = useCallback(() => {
    if (activeCommand !== 'bspline') return;
    if (drawPts.length >= 4) {
      pushSketchHistory();
      const ids: string[] = [];
      for (const dp of drawPts) {
        ids.push(placeSketchPoint(dp.x, dp.y, dp.snapped));
      }
      addBspline(ids);
      setDrawPts([]);
      setStatusMessage('B-spline created');
    } else if (drawPts.length > 0) {
      setStatusMessage('B-spline needs at least 4 control points');
    }
  }, [
    activeCommand,
    drawPts,
    setStatusMessage,
    pushSketchHistory,
    placeSketchPoint,
    addBspline,
  ]);

  const handleDoubleClick = useCallback(() => {
    if (activeCommand === 'bspline') {
      finalizeBsplineDraw();
      return;
    }
    if (activeCommand === 'polyline' && drawPts.length > 0) {
      setDrawPts([]);
      setStatusMessage('Polyline finished');
    }
  }, [activeCommand, drawPts, setStatusMessage, finalizeBsplineDraw]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (activeModule !== 'sketch') return;
      const el = e.target as HTMLElement | null;
      if (
        el?.closest?.('input, textarea, [contenteditable="true"]') &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')
      ) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoSketch();
        return;
      }
      if (mod && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redoSketch();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoSketch();
        return;
      }
      if (activeCommand === 'bspline' && e.key === 'Enter') {
        e.preventDefault();
        finalizeBsplineDraw();
        return;
      }
      if (activeCommand === 'bspline' && e.key === 'Escape') {
        e.preventDefault();
        setDrawPts([]);
        setActiveCommand(null);
        setStatusMessage('');
        return;
      }
      if (e.key === 'Escape') {
        setDrawPts([]);
        clearSelection();
        clearPendingConstraintSelection();
        setActiveCommand(null);
        setStatusMessage('');
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection.length > 0) {
          deleteSelected();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    activeModule,
    activeCommand,
    undoSketch,
    redoSketch,
    clearSelection,
    clearPendingConstraintSelection,
    deleteSelected,
    selection.length,
    setActiveCommand,
    setStatusMessage,
    finalizeBsplineDraw,
  ]);

  useEffect(() => {
    setDrawPts([]);
  }, [activeCommand]);

  useEffect(() => {
    if (activeCommand !== 'arc' || drawPts.length !== 2) {
      arcThirdPointPlacementActiveRef.current = false;
      setArcShiftHeld(false);
      setArcAutoComplementary(false);
      arcPrevCursorLocalRef.current = null;
    }
  }, [activeCommand, drawPts.length]);

  useEffect(() => {
    if (!pendingDimensionInput) {
      setDimensionValue('');
      return;
    }
    if (pendingDimensionInput.defaultExpression?.trim().startsWith('=')) {
      setDimensionValue(pendingDimensionInput.defaultExpression.trim());
    } else {
      setDimensionValue(pendingDimensionInput.defaultValue.toFixed(pendingDimensionInput.paramKey === 'angle' ? 1 : 2));
    }
  }, [pendingDimensionInput]);

  const expressionEnv = useMemo(() => {
    const env: Record<string, number> = {};
    for (const p of userParameters) env[p.name] = p.resultValue;
    for (const p of dimensionParameters) env[p.name] = p.resultValue;
    return env;
  }, [userParameters, dimensionParameters]);
  const parameterNames = useMemo(
    () => [...userParameters.map((p) => p.name), ...dimensionParameters.map((p) => p.name)],
    [userParameters, dimensionParameters]
  );
  const currentEditingDimensionName = useMemo(() => {
    if (!pendingDimensionInput?.constraintId || !activeSketchId) return null;
    const match = dimensionParameters.find(
      (d) =>
        d.target.kind === 'sketchConstraint' &&
        d.target.featureId === activeSketchId &&
        d.target.constraintId === pendingDimensionInput.constraintId &&
        d.target.paramKey === pendingDimensionInput.paramKey
    );
    return match?.name ?? null;
  }, [pendingDimensionInput, activeSketchId, dimensionParameters]);
  const dimensionPreview = useMemo(
    () => evaluateInputExpression(dimensionValue, expressionEnv, currentEditingDimensionName ?? undefined),
    [dimensionValue, expressionEnv, currentEditingDimensionName]
  );
  const dimTokenMatch = dimensionValue.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  const dimToken = dimTokenMatch?.[1] ?? '';
  const dimSuggestions = dimensionValue.trim().startsWith('=')
    ? parameterNames
      .filter((n) => n.toUpperCase().startsWith(dimToken.toUpperCase()) && n !== dimToken)
      .filter((n) => n !== currentEditingDimensionName)
      .slice(0, 8)
    : [];
  const applyDimSuggestion = (picked: string) => {
    const next = dimTokenMatch
      ? `${dimensionValue.slice(0, dimTokenMatch.index ?? dimensionValue.length)}${picked}`
      : `${dimensionValue}${picked}`;
    setDimensionValue(next);
    setDimSuggestOpen(false);
    setDimSuggestIdx(0);
  };
  useEffect(() => {
    setDimensionInputError('');
  }, [dimensionValue]);

  // ---- All hooks must appear before any conditional return ----

  const isSelected = useCallback(
    (type: string, id: string) => selection.some((s) => s.type === type && s.id === id),
    [selection]
  );

  const isHovered = useCallback(
    (type: string, id: string) =>
      hoveredEntity?.type === type && hoveredEntity?.id === id,
    [hoveredEntity]
  );

  const dofState = useMemo(() => {
    // DoF estimation is expensive (many planegcs solves). Freeze during drag.
    if (draggingPointId || isDraggingEntity || isDraggingCircleRadius) return dofCacheRef.current;

    const next = computeSketchDoFState({
      points,
      lines,
      circles,
      arcs,
      constraints,
      bsplines,
    });
    dofCacheRef.current = next;
    return next;
  }, [points, lines, circles, arcs, constraints, bsplines, draggingPointId, isDraggingEntity, isDraggingCircleRadius]);

  const fullyConstrainedPointIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, d] of dofState.pointDoF.entries()) if (d === 0) ids.add(id);
    return ids;
  }, [dofState]);
  const fullyConstrainedLineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, d] of dofState.lineDoF.entries()) if (d === 0) ids.add(id);
    return ids;
  }, [dofState]);
  const fullyConstrainedArcIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, d] of dofState.arcDoF.entries()) if (d === 0) ids.add(id);
    return ids;
  }, [dofState]);
  const fullyConstrainedCircleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, d] of dofState.circleDoF.entries()) if (d === 0) ids.add(id);
    return ids;
  }, [dofState]);
  const getEntityColor = useCallback(
    (type: string, id: string) => {
      if (isSelected(type, id)) return COLORS.entitySelected;
      if (isHovered(type, id)) return COLORS.entityHover;
      if (type === 'line' && fullyConstrainedLineIds.has(id)) return COLORS.constrained;
      if (type === 'circle' && fullyConstrainedCircleIds.has(id)) return COLORS.constrained;
      if (type === 'arc' && fullyConstrainedArcIds.has(id)) return COLORS.constrained;
      return COLORS.entity;
    },
    [isSelected, isHovered, fullyConstrainedLineIds, fullyConstrainedCircleIds, fullyConstrainedArcIds]
  );

  const getPointColor = useCallback(
    (id: string) => {
      if (isSelected('point', id)) return COLORS.pointSelected;
      if (isHovered('point', id)) return COLORS.pointHover;
      if (fullyConstrainedPointIds.has(id)) return COLORS.constrained;
      return COLORS.point;
    },
    [isSelected, isHovered, fullyConstrainedPointIds]
  );

  const constraintIcons = useMemo(() => {
    const icons: { id: string; x: number; y: number; label: string; color: string }[] = [];
    for (const c of constraints) {
      if (c.type === 'arcRadius') continue;
      if (DIMENSION_TYPES.has(c.type)) continue;
      if (isProtectedOriginFixConstraint(c)) continue;
      let cx = 0,
        cy = 0;

      const line = lines.find((l) => l.id === c.entityIds[0]);
      if (line) {
        const p1 = points.find((p) => p.id === line.p1Id);
        const p2 = points.find((p) => p.id === line.p2Id);
        if (p1 && p2) {
          cx = (p1.x + p2.x) / 2;
          cy = (p1.y + p2.y) / 2;
        }
      } else {
        const pt = points.find((p) => p.id === c.entityIds[0]);
        if (pt) {
          cx = pt.x;
          cy = pt.y;
        }
      }

      const labels: Record<string, string> = {
        fix: 'FIX',
        coincident: '◉',
        horizontal: 'H',
        vertical: 'V',
        equal: '=',
        parallel: '∥',
        perpendicular: '⊥',
        tangent: 'T',
        concentric: '⊙',
        midpoint: 'M',
        pointOnLine: '⊕',
        symmetry: '⇄',
      };

      icons.push({
        id: c.id,
        x: cx,
        y: cy,
        label: labels[c.type] || '?',
        color: isSelected('constraint', c.id) ? COLORS.entitySelected : COLORS.constraint,
      });
    }
    return icons;
  }, [constraints, lines, points, isSelected, isProtectedOriginFixConstraint]);

  const dimensionAnnotations = useMemo(() => {
    const dims: {
      id: string;
      type: string;
      x1: number; y1: number;
      x2: number; y2: number;
      labelX: number; labelY: number;
      text: string;
      offsetDir: 'h' | 'v' | 'perp' | 'radial';
      dragAxisX: number;
      dragAxisY: number;
    }[] = [];

    for (const c of constraints) {
      if (!DIMENSION_TYPES.has(c.type)) continue;
      const off = 0.8;
          const labelDx = Number(c.params?.labelDx ?? 0);
          const labelDy = Number(c.params?.labelDy ?? 0);

      if ((c.type === 'length' || c.type === 'distance') && c.params?.distance != null) {
        const line = lines.find((l) => l.id === c.entityIds[0]);
        if (line) {
          const p1 = points.find((p) => p.id === line.p1Id);
          const p2 = points.find((p) => p.id === line.p2Id);
          if (p1 && p2) {
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / len, ny = dx / len;
            dims.push({
              id: c.id, type: c.type,
              x1: p1.x + nx * off + labelDx, y1: p1.y + ny * off + labelDy,
              x2: p2.x + nx * off + labelDx, y2: p2.y + ny * off + labelDy,
              labelX: mx + nx * off + labelDx, labelY: my + ny * off + labelDy,
              text: c.params.distance.toFixed(2),
              offsetDir: 'perp',
              dragAxisX: nx,
              dragAxisY: ny,
            });
          }
        } else if (c.entityIds.length === 2) {
          const p1 = points.find((p) => p.id === c.entityIds[0]);
          const p2 = points.find((p) => p.id === c.entityIds[1]);
          if (p1 && p2) {
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            dims.push({
              id: c.id, type: c.type,
              x1: p1.x + labelDx, y1: p1.y - off + labelDy,
              x2: p2.x + labelDx, y2: p2.y - off + labelDy,
              labelX: mx + labelDx, labelY: my - off + labelDy,
              text: c.params.distance.toFixed(2),
              offsetDir: 'h',
              dragAxisX: 0,
              dragAxisY: 1,
            });
          }
        }
      }

      if (c.type === 'horizontalDistance' && c.params?.distance != null) {
        const p1 = points.find((p) => p.id === c.entityIds[0]);
        const p2 = points.find((p) => p.id === c.entityIds[1]);
        if (p1 && p2) {
          const y = Math.min(p1.y, p2.y) - off;
          dims.push({
            id: c.id, type: c.type,
            x1: p1.x + labelDx, y1: y + labelDy,
            x2: p2.x + labelDx, y2: y + labelDy,
            labelX: (p1.x + p2.x) / 2 + labelDx, labelY: y + labelDy,
            text: c.params.distance.toFixed(2),
            offsetDir: 'h',
            dragAxisX: 0,
            dragAxisY: 1,
          });
        }
      }

      if (c.type === 'verticalDistance' && c.params?.distance != null) {
        const p1 = points.find((p) => p.id === c.entityIds[0]);
        const p2 = points.find((p) => p.id === c.entityIds[1]);
        if (p1 && p2) {
          const x = Math.max(p1.x, p2.x) + off;
          dims.push({
            id: c.id, type: c.type,
            x1: x + labelDx, y1: p1.y + labelDy,
            x2: x + labelDx, y2: p2.y + labelDy,
            labelX: x + labelDx, labelY: (p1.y + p2.y) / 2 + labelDy,
            text: c.params.distance.toFixed(2),
            offsetDir: 'v',
            dragAxisX: 1,
            dragAxisY: 0,
          });
        }
      }

      if (c.type === 'radius' && c.params?.radius != null) {
        const circ = circles.find((ci) => ci.id === c.entityIds[0]);
        if (circ) {
          const center = points.find((p) => p.id === circ.centerId);
          if (center) {
            const th = Number(c.params?.radiusDimAngle ?? 0);
            const ux = Math.cos(th);
            const uy = Math.sin(th);
            const r = circ.radius;
            const mx = center.x + (r * 0.5) * ux;
            const my = center.y + (r * 0.5) * uy;
            const px = -uy * off * 0.5;
            const py = ux * off * 0.5;
            dims.push({
              id: c.id, type: c.type,
              x1: center.x + labelDx, y1: center.y + labelDy,
              x2: center.x + r * ux + labelDx, y2: center.y + r * uy + labelDy,
              labelX: mx + labelDx + px, labelY: my + labelDy + py,
              text: `R${c.params.radius.toFixed(2)}`,
              offsetDir: 'radial',
              dragAxisX: 0,
              dragAxisY: 1,
            });
          }
        }
        const arc = arcs.find((a) => a.id === c.entityIds[0]);
        if (arc) {
          const center = points.find((p) => p.id === arc.centerId);
          const start = points.find((p) => p.id === arc.startId);
          if (center && start) {
            const rdx = start.x - center.x;
            const rdy = start.y - center.y;
            const rlen = Math.sqrt(rdx * rdx + rdy * rdy) || 1;
            dims.push({
              id: c.id, type: c.type,
              x1: center.x + labelDx, y1: center.y + labelDy,
              x2: start.x + labelDx, y2: start.y + labelDy,
              labelX: (center.x + start.x) / 2 + labelDx, labelY: (center.y + start.y) / 2 + off * 0.5 + labelDy,
              text: `R${c.params.radius.toFixed(2)}`,
              offsetDir: 'radial',
              dragAxisX: -rdy / rlen,
              dragAxisY: rdx / rlen,
            });
          }
        }
      }

      if (c.type === 'angle' && c.params?.angle != null) {
        const l1 = lines.find((l) => l.id === c.entityIds[0]);
        const l2 = lines.find((l) => l.id === c.entityIds[1]);
        if (l1 && l2) {
          const p1a = points.find((p) => p.id === l1.p1Id);
          const p1b = points.find((p) => p.id === l1.p2Id);
          const p2a = points.find((p) => p.id === l2.p1Id);
          const p2b = points.find((p) => p.id === l2.p2Id);
          if (p1a && p1b && p2a && p2b) {
            const mx = (p1a.x + p1b.x + p2a.x + p2b.x) / 4;
            const my = (p1a.y + p1b.y + p2a.y + p2b.y) / 4;
            dims.push({
              id: c.id, type: c.type,
              x1: mx + labelDx, y1: my + labelDy, x2: mx + labelDx, y2: my + labelDy,
              labelX: mx + labelDx, labelY: my + off + labelDy,
              text: `${c.params.angle.toFixed(1)}°`,
              offsetDir: 'perp',
              dragAxisX: 0,
              dragAxisY: 1,
            });
          }
        }
      }
    }
    return dims;
  }, [constraints, lines, circles, arcs, points]);

  const pickSketchEntityAtScreen = useCallback(
    (sx: number, sy: number): SelectionItem | null => {
      const world = screenToWorld(sx, sy);
      const hitThreshold = 8 / zoom;

      const labels: Record<string, string> = {
        fix: 'FIX',
        coincident: '◉',
        horizontal: 'H',
        vertical: 'V',
        equal: '=',
        parallel: '∥',
        perpendicular: '⊥',
        tangent: 'T',
        concentric: '⊙',
        midpoint: 'M',
        pointOnLine: '⊕',
        symmetry: '⇄',
      };

      const clickedIcon = constraints
        .filter((c) => c.type !== 'arcRadius' && !DIMENSION_TYPES.has(c.type) && !!labels[c.type] && !isProtectedOriginFixConstraint(c))
        .map((c) => {
          let cx = 0;
          let cy = 0;
          const line = lines.find((l) => l.id === c.entityIds[0]);
          if (line) {
            const p1 = points.find((p) => p.id === line.p1Id);
            const p2 = points.find((p) => p.id === line.p2Id);
            if (p1 && p2) {
              cx = (p1.x + p2.x) / 2;
              cy = (p1.y + p2.y) / 2;
            }
          } else {
            const pt = points.find((p) => p.id === c.entityIds[0]);
            if (pt) {
              cx = pt.x;
              cy = pt.y;
            }
          }
          return { id: c.id, x: cx, y: cy };
        })
        .find((icon) => {
          const screen = worldToScreen(icon.x, icon.y);
          const ix = screen.x + 12;
          const iy = screen.y - 12;
          const dx = sx - ix;
          const dy = sy - iy;
          return dx * dx + dy * dy <= 12 * 12;
        });
      if (clickedIcon) return { type: 'constraint', id: clickedIcon.id };

      const distToSegPx = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      };

      for (const dim of dimensionAnnotations) {
        const s1 = worldToScreen(dim.x1, dim.y1);
        const s2 = worldToScreen(dim.x2, dim.y2);
        const sLabel = worldToScreen(dim.labelX, dim.labelY);
        if (distToSegPx(sx, sy, s1.x, s1.y, s2.x, s2.y) <= 10) {
          return { type: 'constraint', id: dim.id };
        }
        const halfW = dim.text.length * 3.5 + 3;
        if (
          sx >= sLabel.x - halfW &&
          sx <= sLabel.x + halfW &&
          sy >= sLabel.y - 14 &&
          sy <= sLabel.y + 2
        ) {
          return { type: 'constraint', id: dim.id };
        }
      }

      const nearPointId = findNearestPoint(world.x, world.y, hitThreshold);
      if (nearPointId) return { type: 'point', id: nearPointId };

      const entity = findNearestEntity(world.x, world.y, hitThreshold);
      if (!entity) return null;
      if (
        entity.type === 'line' &&
        (entity.id === SKETCH_REF_X_AXIS_ID || entity.id === SKETCH_REF_Y_AXIS_ID)
      ) {
        return null;
      }
      return entity;
    },
    [
      screenToWorld,
      zoom,
      constraints,
      isProtectedOriginFixConstraint,
      lines,
      points,
      dimensionAnnotations,
      worldToScreen,
      findNearestPoint,
      findNearestEntity,
    ]
  );

  const handleSketchContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const item = pickSketchEntityAtScreen(sx, sy);
      if (item) {
        setSketchContextMenu({ x: e.clientX, y: e.clientY, item });
      } else {
        setSketchContextMenu(null);
      }
    },
    [pickSketchEntityAtScreen]
  );

  const handleSketchContextDelete = useCallback(() => {
    if (!sketchContextMenu) return;
    useSketchStore.setState({ selection: [sketchContextMenu.item] });
    deleteSelected();
    setSketchContextMenu(null);
  }, [sketchContextMenu, deleteSelected]);

  const handleSketchContextToggleAux = useCallback(() => {
    if (!sketchContextMenu) return;
    const t = sketchContextMenu.item.type;
    if (t !== 'line' && t !== 'circle' && t !== 'arc' && t !== 'bspline') return;
    useSketchStore.setState({ selection: [sketchContextMenu.item] });
    toggleAuxiliarySelected();
    setSketchContextMenu(null);
  }, [sketchContextMenu, toggleAuxiliarySelected]);

  useEffect(() => {
    if (!sketchContextMenu) return;
    const close = (ev: MouseEvent) => {
      if (sketchMenuRef.current && !sketchMenuRef.current.contains(ev.target as Node)) {
        setSketchContextMenu(null);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setSketchContextMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [sketchContextMenu]);

  const tempRadius =
    drawPts.length === 1 && activeCommand === 'circle'
      ? Math.sqrt(
          (snappedCursor.x - drawPts[0].x) ** 2 +
            (snappedCursor.y - drawPts[0].y) ** 2
        )
      : 0;

  const arcPath = useMemo(() => {
    if (activeCommand !== 'arc' || drawPts.length < 2) return '';
    const center = drawPts[0];
    const startPt = drawPts[1];
    const r = Math.sqrt((startPt.x - center.x) ** 2 + (startPt.y - center.y) ** 2);
    if (r < 0.01) return '';
    const endAngle = Math.atan2(snappedCursor.y - center.y, snappedCursor.x - center.x);
    const end = { x: center.x + r * Math.cos(endAngle), y: center.y + r * Math.sin(endAngle) };
    const arcPts = sampleArcPoints(center, startPt, end, Math.PI / 24, {
      complementaryArc: arcAutoComplementary !== arcShiftHeld,
    });
    if (arcPts.length < 2) return '';
    return `M ${arcPts[0].x} ${arcPts[0].y} L ${arcPts.slice(1).map((p) => `${p.x} ${p.y}`).join(' L ')}`;
  }, [activeCommand, drawPts, snappedCursor, arcShiftHeld, arcAutoComplementary]);

  const renderArcPath = useCallback(
    (arcItem: {
      centerId: string;
      startId: string;
      endId: string;
      id: string;
      complementaryArc?: boolean;
      auxiliary?: boolean;
    }) => {
      const center = points.find((p) => p.id === arcItem.centerId);
      const start = points.find((p) => p.id === arcItem.startId);
      const end = points.find((p) => p.id === arcItem.endId);
      if (!center || !start || !end) return null;
      const arcPts = sampleArcPoints(
        { x: center.x, y: center.y },
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
        Math.PI / 24,
        { complementaryArc: !!arcItem.complementaryArc },
      );
      if (arcPts.length < 2) return null;
      const color = getEntityColor('arc', arcItem.id);
      const sw = 2 / zoom;
      const inv = 1 / zoom;
      const dash = arcItem.auxiliary ? `${4 * inv} ${3 * inv}` : undefined;
      return (
        <path
          key={arcItem.id}
          d={`M ${arcPts[0].x} ${arcPts[0].y} L ${arcPts.slice(1).map((p) => `${p.x} ${p.y}`).join(' L ')}`}
          stroke={color}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={dash}
        />
      );
    },
    [points, zoom, getEntityColor]
  );

  const renderBsplinePath = useCallback(
    (b: SketchBspline) => {
      const deg = b.degree ?? BSPLINE_DEFAULT_DEGREE;
      const ctrl: { x: number; y: number }[] = [];
      for (const id of b.controlPointIds) {
        const p = points.find((q) => q.id === id);
        if (!p) return null;
        ctrl.push({ x: p.x, y: p.y });
      }
      if (ctrl.length < deg + 1) return null;
      const splinePts = sampleOpenUniformBSpline(ctrl, deg, BSPLINE_DEFAULT_SAMPLES_PER_SPAN);
      if (splinePts.length < 2) return null;
      const color = getEntityColor('bspline', b.id);
      const sw = 2 / zoom;
      const inv = 1 / zoom;
      const dash = b.auxiliary ? `${4 * inv} ${3 * inv}` : undefined;
      return (
        <path
          key={b.id}
          d={`M ${splinePts[0].x} ${splinePts[0].y} L ${splinePts.slice(1).map((p) => `${p.x} ${p.y}`).join(' L ')}`}
          stroke={color}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={dash}
        />
      );
    },
    [points, zoom, getEntityColor]
  );

  const [crossSectionTris, setCrossSectionTris] = useState<
    { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }[]
  >([]);
  const [crossSectionEdges, setCrossSectionEdges] = useState<
    { x1: number; y1: number; x2: number; y2: number }[]
  >([]);

  // B-Rep-based background section: intersect solids with sketch plane (thin slab).
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeSketchId) {
        if (!cancelled) {
          setCrossSectionTris([]);
          setCrossSectionEdges([]);
        }
        return;
      }
      if (!isCADReady()) {
        try { await initCAD(); } catch { /* ignore */ }
      }
      if (!isCADReady()) {
        if (!cancelled) {
          setCrossSectionTris([]);
          setCrossSectionEdges([]);
        }
        return;
      }
      const activeSketch = features.find((f) => f.id === activeSketchId) as SketchFeature | undefined;
      if (!activeSketch) {
        if (!cancelled) {
          setCrossSectionTris([]);
          setCrossSectionEdges([]);
        }
        return;
      }
      const overlay = buildSectionSketchOverlay2D(featuresToCadFeatureInputs(features), activeSketch);
      if (cancelled) return;
      setCrossSectionTris(overlay.triangles);
      setCrossSectionEdges(overlay.edgeSegments);
    };
    run();
    return () => { cancelled = true; };
  }, [features, activeSketchId]);

  // Closed-loop region detection with support for nested holes
  const sketchRegions = useMemo(() => {
    const { canonical, mergedPtMap: ptMap } = mergeCoincidentSketchVertices(points, constraints);
    const loops: Loop2D[] = [];

    // Build mixed edge graph from all supported segments that participate in loops
    const edges: LoopEdge[] = [];
    for (const l of lines) {
      if (l.auxiliary) continue;
      const a = canonical(l.p1Id);
      const b = canonical(l.p2Id);
      if (a === b) continue;
      const p1 = ptMap.get(a);
      const p2 = ptMap.get(b);
      if (!p1 || !p2) continue;
      edges.push({
        id: `line_${l.id}`,
        a,
        b,
        path: [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }],
      });
    }
    for (const ar of arcs) {
      if (ar.auxiliary) continue;
      const ca = canonical(ar.centerId);
      const sa = canonical(ar.startId);
      const ea = canonical(ar.endId);
      const c = ptMap.get(ca);
      const s = ptMap.get(sa);
      const e = ptMap.get(ea);
      if (!c || !s || !e) continue;
      const path = sampleArcPoints(
        { x: c.x, y: c.y },
        { x: s.x, y: s.y },
        { x: e.x, y: e.y },
        Math.PI / 24,
        { complementaryArc: !!ar.complementaryArc }
      );
      if (path.length < 2) continue;
      if (sa === ea) continue;
      edges.push({
        id: `arc_${ar.id}`,
        a: sa,
        b: ea,
        path,
      });
    }
    for (const bs of bsplines) {
      if (bs.auxiliary) continue;
      const deg = bs.degree ?? BSPLINE_DEFAULT_DEGREE;
      const cids = bs.controlPointIds.map((id) => canonical(id));
      const ctrl = cids
        .map((id) => ptMap.get(id))
        .filter((p): p is { x: number; y: number } => !!p);
      if (ctrl.length !== cids.length || ctrl.length < deg + 1) continue;
      const path = sampleOpenUniformBSpline(ctrl, deg, BSPLINE_DEFAULT_SAMPLES_PER_SPAN);
      if (path.length < 2) continue;
      const va = cids[0]!;
      const vb = cids[cids.length - 1]!;
      edges.push({ id: `bspline_${bs.id}`, a: va, b: vb, path });
    }

    // Traverse unused edges into closed node loops
    const adj = new Map<string, { edgeId: string; other: string }[]>();
    for (const e of edges) {
      if (!adj.has(e.a)) adj.set(e.a, []);
      if (!adj.has(e.b)) adj.set(e.b, []);
      adj.get(e.a)!.push({ edgeId: e.id, other: e.b });
      adj.get(e.b)!.push({ edgeId: e.id, other: e.a });
    }
    const edgeById = new Map(edges.map((e) => [e.id, e]));
    const usedEdges = new Set<string>();
    let loopIdx = 0;

    for (const startEdge of edges) {
      if (usedEdges.has(startEdge.id)) continue;
      const startNode = startEdge.a;
      let curNode = startEdge.b;
      let prevNode = startEdge.a;
      const pathPts: { x: number; y: number }[] = [...startEdge.path];
      const thisLoopUsed = new Set<string>([startEdge.id]);
      let incomingEdgeId = startEdge.id;

      while (curNode !== startNode) {
        const nbrs = (adj.get(curNode) ?? []).filter((n) => !thisLoopUsed.has(n.edgeId));
        if (!nbrs.length) break;
        const next = pickNextEdgeInFace(curNode, prevNode, incomingEdgeId, nbrs, ptMap, edgeById) ?? nbrs[0];
        const seg = edgeById.get(next.edgeId);
        if (!seg) break;
        thisLoopUsed.add(seg.id);

        const forward = seg.a === curNode;
        const segPts = forward ? seg.path : [...seg.path].reverse();
        // Stitch without duplicating junction point
        pathPts.push(...segPts.slice(1));

        incomingEdgeId = next.edgeId;
        prevNode = curNode;
        curNode = next.other;
      }

      if (curNode === startNode && pathPts.length >= 3) {
        for (const id of thisLoopUsed) usedEdges.add(id);
        const pts = snapClosedPolyline(pathPts);
        const meta = computeLoopMeta(pts, `mixed_${loopIdx++}`);
        if (meta) loops.push(meta);
      }
    }

    // Full circles as closed loops
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      if (c.auxiliary) continue;
      const cc = canonical(c.centerId);
      const center = ptMap.get(cc);
      if (!center || c.radius <= 1e-8) continue;
      const segs = 72;
      const pts: { x: number; y: number }[] = [];
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        pts.push({ x: center.x + c.radius * Math.cos(a), y: center.y + c.radius * Math.sin(a) });
      }
      const meta = computeLoopMeta(pts, `circle_${c.id}`);
      if (meta) loops.push(meta);
    }

    // Sort by area asc so smallest container parent can be found quickly
    const order = [...loops].sort((a, b) => a.areaAbs - b.areaAbs);
    const depth = new Map<string, number>();
    const parent = new Map<string, string | null>();

    for (const l of order) {
      let bestParent: Loop2D | null = null;
      for (const cand of loops) {
        if (cand.id === l.id) continue;
        if (cand.areaAbs <= l.areaAbs) continue;
        if (
          l.bbox.minX < cand.bbox.minX || l.bbox.maxX > cand.bbox.maxX ||
          l.bbox.minY < cand.bbox.minY || l.bbox.maxY > cand.bbox.maxY
        ) continue;
        if (!pointInPolygon(l.centroid, cand.pts)) continue;
        if (!bestParent || cand.areaAbs < bestParent.areaAbs) bestParent = cand;
      }
      parent.set(l.id, bestParent?.id ?? null);
      depth.set(l.id, bestParent ? ((depth.get(bestParent.id) ?? 0) + 1) : 0);
    }

    // Build regions from even-depth loops, with immediate odd-depth children as holes
    const regions: { outer: Loop2D; holes: Loop2D[]; path: string }[] = [];
    for (const l of loops) {
      const d = depth.get(l.id) ?? 0;
      if (d % 2 !== 0) continue; // odd loops are holes
      const holes = loops.filter((h) => (parent.get(h.id) === l.id) && ((depth.get(h.id) ?? 0) === d + 1));
      const toPath = (pts: { x: number; y: number }[]) =>
        pts.length ? `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z` : '';
      const path = [toPath(l.pts), ...holes.map((h) => toPath(h.pts))].join(' ');
      regions.push({ outer: l, holes, path });
    }

    return regions;
  }, [points, lines, arcs, bsplines, circles, constraints]);

  // Early return AFTER all hooks
  if (activeModule !== 'sketch') return null;

  // Derived locals (not hooks)
  const worldLeft = (-dims.w / 2 - panX) / zoom;
  const worldRight = (dims.w / 2 - panX) / zoom;
  const worldBottom = (panY - dims.h / 2) / zoom;
  const worldTop = (dims.h / 2 + panY) / zoom;

  let gridStep = 1;
  const pixPerStep = gridStep * zoom;
  if (pixPerStep < 15) {
    gridStep = Math.pow(10, Math.ceil(Math.log10(15 / zoom)));
    if (gridStep * zoom < 15) gridStep *= 2;
  } else if (pixPerStep > 150) {
    gridStep = Math.pow(10, Math.floor(Math.log10(150 / zoom)));
  }
  const majorStep = gridStep * 5;

  const gridLinesV: number[] = [];
  const gridLinesH: number[] = [];
  const startX = Math.floor(worldLeft / gridStep) * gridStep;
  const startY = Math.floor(worldBottom / gridStep) * gridStep;
  for (let x = startX; x <= worldRight; x += gridStep) gridLinesV.push(x);
  for (let y = startY; y <= worldTop; y += gridStep) gridLinesH.push(y);

  const transform = `translate(${dims.w / 2 + panX}, ${dims.h / 2 + panY}) scale(${zoom}, ${-zoom})`;
  const invScale = 1 / zoom;
  const ptRadius = 4 * invScale;
  const ptRadiusLarge = 6 * invScale;

  const toolHint = activeCommand
    ? {
        line: 'Click start point, then end point',
        polyline: 'Click points. Double-click to finish',
        bspline: 'Click 4+ control points. Double-click or Enter to create — Esc exits tool',
        circle: 'Click center, then drag radius',
        arc: 'Center, start, end on circle — hold Shift for the other arc branch',
        rectangle: 'Click first corner, then opposite corner',
      }[activeCommand] || ''
    : 'Select entities or choose a tool';

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-10 overflow-hidden [touch-action:none]"
      style={{ background: COLORS.bg, cursor: isDrawingTool(activeCommand) ? 'crosshair' : 'default' }}
    >
      <svg
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleSketchContextMenu}
        style={{ display: 'block', width: '100%', height: '100%' }}
      >
        {/* World-space group (Y flipped) */}
        <g transform={transform}>
          {/* Solid body ∩ sketch plane — behind grid and sketch entities */}
          {crossSectionTris.map((t, i) => (
            <polygon
              key={`xst${i}`}
              points={`${t.x1},${t.y1} ${t.x2},${t.y2} ${t.x3},${t.y3}`}
              fill={COLORS.solidSection}
              fillOpacity={0.88}
              stroke="none"
            />
          ))}

          {/* Minor grid */}
          {gridLinesV.map((x) => (
            <line
              key={`gv${x}`}
              x1={x}
              y1={worldBottom}
              x2={x}
              y2={worldTop}
              stroke={Math.abs(x % majorStep) < gridStep * 0.1 ? COLORS.gridMajor : COLORS.grid}
              strokeWidth={invScale}
            />
          ))}
          {gridLinesH.map((y) => (
          <line 
              key={`gh${y}`}
              x1={worldLeft}
              y1={y}
              x2={worldRight}
              y2={y}
              stroke={Math.abs(y % majorStep) < gridStep * 0.1 ? COLORS.gridMajor : COLORS.grid}
              strokeWidth={invScale}
          />
        ))}

          {/* Solid section edges (B-Rep edges projected to sketch plane) */}
          {crossSectionEdges.map((e, i) => (
            <line
              key={`xse${i}`}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke={COLORS.solidSectionEdge}
              strokeWidth={1.25 * invScale}
              strokeLinecap="round"
              pointerEvents="none"
            />
          ))}

          {/* Axes */}
          <line
            x1={worldLeft}
            y1={0}
            x2={worldRight}
            y2={0}
            stroke={isSelected('line', SKETCH_REF_X_AXIS_ID) ? COLORS.entitySelected : COLORS.axisX}
            strokeWidth={(isSelected('line', SKETCH_REF_X_AXIS_ID) ? 2.5 : 1.5) * invScale}
            opacity={0.6}
          />
          <line
            x1={0}
            y1={worldBottom}
            x2={0}
            y2={worldTop}
            stroke={isSelected('line', SKETCH_REF_Y_AXIS_ID) ? COLORS.entitySelected : COLORS.axisY}
            strokeWidth={(isSelected('line', SKETCH_REF_Y_AXIS_ID) ? 2.5 : 1.5) * invScale}
            opacity={0.6}
          />

          {/* Filled sketch regions (closed loops with nested holes) */}
          {sketchRegions.map((r, i) => (
            <path
              key={`region_${i}`}
              d={r.path}
              fill={dofState.isSketchFullyConstrained ? COLORS.constrained : COLORS.entity}
              fillOpacity={0.22}
              fillRule="evenodd"
              stroke="none"
            />
          ))}

          {/* Lines */}
          {lines.map((l) => {
            const p1 = points.find((p) => p.id === l.p1Id);
            const p2 = points.find((p) => p.id === l.p2Id);
            if (!p1 || !p2) return null;
            const color = getEntityColor('line', l.id);
            return (
              <line
                key={l.id}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={color}
                strokeWidth={2 * invScale}
                strokeDasharray={l.auxiliary ? `${4 * invScale} ${3 * invScale}` : undefined}
              />
            );
          })}

          {/* Circles */}
          {circles.map((c) => {
            const center = points.find((p) => p.id === c.centerId);
            if (!center) return null;
            const color = getEntityColor('circle', c.id);
            return (
              <circle
                key={c.id}
                cx={center.x}
                cy={center.y}
                r={c.radius}
                stroke={color}
                strokeWidth={2 * invScale}
                fill="none"
                strokeDasharray={c.auxiliary ? `${4 * invScale} ${3 * invScale}` : undefined}
              />
            );
          })}

          {/* Arcs */}
          {arcs.map(renderArcPath)}

          {/* B-splines */}
          {bsplines.map(renderBsplinePath)}

          {/* Points */}
          {points.map((pt) => {
            const color = getPointColor(pt.id);
            const r = isSelected('point', pt.id) || isHovered('point', pt.id)
              ? ptRadiusLarge
              : ptRadius;
            return (
              <circle
                key={pt.id}
                cx={pt.x}
                cy={pt.y}
                r={r}
                fill={color}
                stroke="#0f172a"
                strokeWidth={invScale}
              />
            );
          })}

          {/* Snap indicator */}
          {snapIndicator && (() => {
            const sp = points.find((p) => p.id === snapIndicator);
            if (!sp) return null;
            return (
              <circle
                cx={sp.x}
                cy={sp.y}
                r={8 * invScale}
                fill="none"
                stroke="#22c55e"
                strokeWidth={1.5 * invScale}
                strokeDasharray={`${3 * invScale}`}
              />
            );
          })()}

          {/* Temp geometry: Line */}
          {drawPts.length === 1 &&
            (activeCommand === 'line' || activeCommand === 'polyline') && (
           <line 
                x1={drawPts[0].x}
                y1={drawPts[0].y}
                x2={snappedCursor.x}
                y2={snappedCursor.y}
                stroke={COLORS.temp}
                strokeWidth={2 * invScale}
                strokeDasharray={`${4 * invScale}`}
              />
            )}

          {/* Temp geometry: Circle */}
          {drawPts.length === 1 && activeCommand === 'circle' && tempRadius > 0.01 && (
            <circle
              cx={drawPts[0].x}
              cy={drawPts[0].y}
              r={tempRadius}
              stroke={COLORS.temp}
              strokeWidth={2 * invScale}
              fill="none"
              strokeDasharray={`${4 * invScale}`}
            />
          )}

          {/* Temp geometry: Arc */}
          {drawPts.length === 1 && activeCommand === 'arc' && (
           <line 
              x1={drawPts[0].x}
              y1={drawPts[0].y}
              x2={snappedCursor.x}
              y2={snappedCursor.y}
              stroke={COLORS.temp}
              strokeWidth={invScale}
              strokeDasharray={`${4 * invScale}`}
            />
          )}
          {drawPts.length === 2 && activeCommand === 'arc' && arcPath && (
            <path
              d={arcPath}
              stroke={COLORS.temp}
              strokeWidth={2 * invScale}
              fill="none"
              strokeDasharray={`${4 * invScale}`}
            />
          )}

          {/* Temp: B-spline control polygon + preview curve */}
          {activeCommand === 'bspline' &&
            drawPts.length >= 2 &&
            drawPts.map((dp, i) => {
              if (i === 0) return null;
              const prev = drawPts[i - 1];
              return (
                <line
                  key={`bspctrl${i}`}
                  x1={prev.x}
                  y1={prev.y}
                  x2={dp.x}
                  y2={dp.y}
                  stroke={COLORS.temp}
                  strokeWidth={invScale}
                  strokeDasharray={`${3 * invScale}`}
                />
              );
            })}
          {activeCommand === 'bspline' &&
            drawPts.length >= 4 &&
            (() => {
              const sp = sampleOpenUniformBSpline(
                drawPts,
                BSPLINE_DEFAULT_DEGREE,
                BSPLINE_DEFAULT_SAMPLES_PER_SPAN
              );
              if (sp.length < 2) return null;
              return (
                <path
                  d={`M ${sp[0].x} ${sp[0].y} L ${sp.slice(1).map((p) => `${p.x} ${p.y}`).join(' L ')}`}
                  stroke={COLORS.temp}
                  strokeWidth={2 * invScale}
                  fill="none"
                  strokeLinecap="round"
                />
              );
            })()}

          {/* Temp geometry: Rectangle */}
          {drawPts.length === 1 && activeCommand === 'rectangle' && (
            <rect
              x={Math.min(drawPts[0].x, snappedCursor.x)}
              y={Math.min(drawPts[0].y, snappedCursor.y)}
              width={Math.abs(snappedCursor.x - drawPts[0].x)}
              height={Math.abs(snappedCursor.y - drawPts[0].y)}
              stroke={COLORS.temp}
              strokeWidth={2 * invScale}
              fill="none"
              strokeDasharray={`${4 * invScale}`}
            />
          )}

          {/* Draw points during drawing */}
          {drawPts.map((dp, i) => (
            <circle
              key={`dp${i}`}
              cx={dp.x}
              cy={dp.y}
              r={ptRadius}
              fill={COLORS.temp}
              stroke="#0f172a"
              strokeWidth={invScale}
            />
          ))}
        </g>

        {/* Screen-space constraint icons */}
        {constraintIcons.map((icon, i) => {
          const screen = worldToScreen(icon.x, icon.y);
          return (
            <text
              key={icon.id || `ci${i}`}
              x={screen.x + 12}
              y={screen.y - 12}
              fill={icon.color}
              fontSize="11"
              fontWeight="bold"
              fontFamily="monospace"
            >
              {icon.label}
            </text>
          );
        })}

        {/* Dimension annotations */}
        {dimensionAnnotations.map((dim) => {
          const constr = constraints.find((cc) => cc.id === dim.id);
          const isRadiusCircle =
            !!constr?.entityIds[0] &&
            constr?.type === 'radius' &&
            circles.some((ci) => ci.id === constr.entityIds[0]);
          const s1 = worldToScreen(dim.x1, dim.y1);
          const s2 = worldToScreen(dim.x2, dim.y2);
          const sLabel = worldToScreen(dim.labelX, dim.labelY);
          const dimColor = isSelected('constraint', dim.id) ? COLORS.entitySelected : COLORS.constraint;
          const arrowSize = 6;
          const dx = s2.x - s1.x, dy = s2.y - s1.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux = dx / len, uy = dy / len;

          const onDimPointerDown = (e: React.PointerEvent) => {
            e.stopPropagation();
            toggleSelect({ type: 'constraint', id: dim.id }, isMultiSelectEvent(e));
            const baseDx = Number(constr?.params?.labelDx ?? 0);
            const baseDy = Number(constr?.params?.labelDy ?? 0);
            const world = screenToWorld(e.clientX, e.clientY);
            pushSketchHistory();
            setDraggingDimension({
              id: dim.id,
              startX: world.x,
              startY: world.y,
              baseDx,
              baseDy,
              axisX: dim.dragAxisX,
              axisY: dim.dragAxisY,
              radiusCircleRotate: isRadiusCircle,
            });
            (e.target as Element).setPointerCapture?.(e.pointerId);
          };

          return (
            <g key={`dim_${dim.id}`}>
              {/* Dimension line */}
              <line x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y}
                stroke={dimColor} strokeWidth={1} opacity={0.8}
                style={{ cursor: 'move' }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSelect({ type: 'constraint', id: dim.id }, isMultiSelectEvent(e));
                }}
                onPointerDown={onDimPointerDown}
              />
              {/* Arrow at start */}
              {len > arrowSize * 3 && (
                <>
                  <line
                    x1={s1.x} y1={s1.y}
                    x2={s1.x + ux * arrowSize - uy * arrowSize * 0.4}
                    y2={s1.y + uy * arrowSize + ux * arrowSize * 0.4}
                    stroke={dimColor} strokeWidth={1} />
                  <line
                    x1={s1.x} y1={s1.y}
                    x2={s1.x + ux * arrowSize + uy * arrowSize * 0.4}
                    y2={s1.y + uy * arrowSize - ux * arrowSize * 0.4}
                    stroke={dimColor} strokeWidth={1} />
                  {/* Arrow at end */}
                  <line
                    x1={s2.x} y1={s2.y}
                    x2={s2.x - ux * arrowSize - uy * arrowSize * 0.4}
                    y2={s2.y - uy * arrowSize + ux * arrowSize * 0.4}
                    stroke={dimColor} strokeWidth={1} />
                  <line
                    x1={s2.x} y1={s2.y}
                    x2={s2.x - ux * arrowSize + uy * arrowSize * 0.4}
                    y2={s2.y - uy * arrowSize - ux * arrowSize * 0.4}
                    stroke={dimColor} strokeWidth={1} />
                </>
              )}
              {/* Background rect for text */}
              <rect
                x={sLabel.x - dim.text.length * 3.5 - 3}
                y={sLabel.y - 14}
                width={dim.text.length * 7 + 6}
                height={16}
                rx={3}
                fill="#ffffff"
                fillOpacity={0.85}
                stroke={dimColor}
                strokeWidth={0.5}
                strokeOpacity={0.5}
                style={{ cursor: 'move' }}
                onPointerDown={onDimPointerDown}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  requestEditDimension(dim.id);
                }}
              />
              {/* Dimension text */}
              <text
                x={sLabel.x}
                y={sLabel.y - 3}
                fill={dimColor}
                fontSize="11"
                fontWeight="600"
                fontFamily="monospace"
                textAnchor="middle"
                style={{ cursor: 'move', userSelect: 'none' }}
                onPointerDown={onDimPointerDown}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  requestEditDimension(dim.id);
                }}
              >
                {dim.text}
              </text>
            </g>
          );
        })}

        {boxSelect && (
          <rect
            x={Math.min(boxSelect.startX, boxSelect.curX)}
            y={Math.min(boxSelect.startY, boxSelect.curY)}
            width={Math.abs(boxSelect.curX - boxSelect.startX)}
            height={Math.abs(boxSelect.curY - boxSelect.startY)}
            fill="#3b82f6"
            fillOpacity={0.12}
            stroke="#2563eb"
            strokeWidth={1}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}

        {/* Cursor crosshair in screen space */}
        {isDrawingTool(activeCommand) && (() => {
          const sc = worldToScreen(snappedCursor.x, snappedCursor.y);
          return (
            <>
              <line
                x1={sc.x - 10}
                y1={sc.y}
                x2={sc.x + 10}
                y2={sc.y}
                stroke="#334155"
                strokeWidth={0.5}
                opacity={0.5}
              />
              <line
                x1={sc.x}
                y1={sc.y - 10}
                x2={sc.x}
                y2={sc.y + 10}
                stroke="#334155"
                strokeWidth={0.5}
                opacity={0.5}
              />
            </>
          );
        })()}
      </svg>

      {sketchContextMenu && (
        <div
          ref={sketchMenuRef}
          className="fixed z-[60] min-w-[140px] bg-white border border-zinc-300 rounded-lg shadow-2xl py-1 overflow-hidden"
          style={{ top: sketchContextMenu.y, left: sketchContextMenu.x }}
        >
          <button
            type="button"
            onClick={handleSketchContextDelete}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-600 hover:text-white transition-colors"
          >
            Delete
          </button>
          {(sketchContextMenu.item.type === 'line' ||
            sketchContextMenu.item.type === 'circle' ||
            sketchContextMenu.item.type === 'arc' ||
            sketchContextMenu.item.type === 'bspline') && (
            <button
              type="button"
              onClick={handleSketchContextToggleAux}
              className="w-full text-left px-4 py-2 text-sm text-zinc-800 hover:bg-zinc-100 transition-colors border-t border-zinc-200"
            >
              Toggle auxiliary
            </button>
          )}
        </div>
      )}

      {/* Status bar */}
      <div className="absolute bottom-0 left-0 right-0 h-7 bg-white/95 border-t border-zinc-300 flex items-center px-3 text-[11px] text-zinc-600 space-x-4 z-20 select-none">
        <span className="text-zinc-600">{toolHint}</span>
        <span className="ml-auto">
          X: <span className="text-zinc-900">{cursor.x.toFixed(2)}</span>
        </span>
        <span>
          Y: <span className="text-zinc-900">{cursor.y.toFixed(2)}</span>
        </span>
        <span className="text-zinc-400">|</span>
        <span>
          Pts: <span className="text-zinc-800">{points.length}</span>
        </span>
        <span>
          Lines: <span className="text-zinc-800">{lines.length}</span>
        </span>
        <span>
          Constraints: <span className="text-zinc-800">{constraints.length}</span>
        </span>
        {statusMessage && (
          <>
            <span className="text-zinc-400">|</span>
            <span className="text-blue-500">{statusMessage}</span>
          </>
        )}
      </div>

      {/* Zoom indicator */}
      <div className="absolute bottom-9 right-3 text-[10px] text-zinc-600 select-none">
        Zoom: {(zoom / 40 * 100).toFixed(0)}%
      </div>

      {pendingDimensionInput && (
        <div className="absolute inset-0 z-30 bg-black/25 flex items-center justify-center">
          <div className="w-80 bg-white rounded-lg shadow-xl border border-zinc-300 p-4">
            <h3 className="text-sm font-semibold text-zinc-900">Set Dimension</h3>
            <p className="text-xs text-zinc-600 mt-1">{pendingDimensionInput.label}</p>
            <div className="relative mt-3">
              <input
                autoFocus
                type="text"
                value={dimensionValue}
                onFocus={() => setDimSuggestOpen(true)}
                onChange={(e) => {
                  setDimensionValue(e.target.value);
                  setDimSuggestOpen(true);
                  setDimSuggestIdx(0);
                }}
                onBlur={() => setTimeout(() => setDimSuggestOpen(false), 120)}
                onKeyDown={(e) => {
                  if (dimSuggestOpen && dimSuggestions.length > 0 && e.key === 'ArrowDown') {
                    e.preventDefault();
                    setDimSuggestIdx((i) => (i + 1) % dimSuggestions.length);
                    return;
                  }
                  if (dimSuggestOpen && dimSuggestions.length > 0 && e.key === 'ArrowUp') {
                    e.preventDefault();
                    setDimSuggestIdx((i) => (i - 1 + dimSuggestions.length) % dimSuggestions.length);
                    return;
                  }
                  if (e.key === 'Enter') {
                    if (dimSuggestOpen && dimSuggestions.length > 0) {
                      e.preventDefault();
                      applyDimSuggestion(dimSuggestions[dimSuggestIdx] ?? dimSuggestions[0]);
                      return;
                    }
                    const res = evaluateInputExpression(dimensionValue, expressionEnv, currentEditingDimensionName ?? undefined);
                    if (!res.ok) {
                      setDimensionInputError(res.message);
                    } else {
                      submitDimensionInput(String(res.value), dimensionValue);
                    }
                  }
                  if (e.key === 'Escape') cancelDimensionInput();
                }}
                className="w-full bg-white border border-zinc-300 rounded py-1.5 px-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
              {dimSuggestOpen && dimSuggestions.length > 0 && (
                <div className="absolute z-40 mt-1 w-full bg-white border border-zinc-300 rounded shadow-lg max-h-44 overflow-auto">
                  {dimSuggestions.map((s, i) => (
                    <button
                      key={s}
                      type="button"
                      onMouseDown={(evt) => {
                        evt.preventDefault();
                        applyDimSuggestion(s);
                      }}
                      className={`w-full text-left px-2 py-1 text-xs ${i === dimSuggestIdx ? 'bg-blue-600 text-white' : 'hover:bg-zinc-100 text-zinc-800'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className={`mt-1 text-xs ${dimensionPreview.ok ? 'text-zinc-600' : 'text-red-500'}`}>
              {dimensionPreview.ok ? `Result: ${dimensionPreview.value.toFixed(4)}` : `Invalid: ${dimensionPreview.message}`}
            </p>
            {dimensionInputError && <p className="mt-1 text-xs text-red-500">{dimensionInputError}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={cancelDimensionInput}
                className="px-3 py-1.5 rounded text-xs font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const res = evaluateInputExpression(dimensionValue, expressionEnv, currentEditingDimensionName ?? undefined);
                  if (!res.ok) {
                    setDimensionInputError(res.message);
                  } else {
                    submitDimensionInput(String(res.value), dimensionValue);
                  }
                }}
                className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded text-xs font-medium transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
