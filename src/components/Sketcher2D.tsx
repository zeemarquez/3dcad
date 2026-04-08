import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useCadStore, type SketchFeature, type ExtrudeFeature, type CutFeature } from '../store/useCadStore';
import {
  useSketchStore,
  type SelectionItem,
  SKETCH_REF_X_AXIS_ID,
  SKETCH_REF_Y_AXIS_ID,
} from '../store/useSketchStore';
import * as THREE from 'three';
import { initCAD, isCADReady, buildSectionTriangles2D, type FeatureInput } from '../lib/cadEngine';
import {
  solveConstraints,
  type SolverPoint,
  type SolverLine,
  type SolverCircle,
  type SolverArc,
  type SolverConstraint,
} from '../lib/constraintSolver';

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

// ──────────────────────────────────────────────────────────────────────────────
// Cross-section: intersect solid geometries with the sketch plane
// ──────────────────────────────────────────────────────────────────────────────
interface Seg2D { x1: number; y1: number; x2: number; y2: number; }

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

function findClosedLoops(lines: { id: string; p1Id: string; p2Id: string }[]): string[][] {
  const adj = new Map<string, { lineId: string; other: string }[]>();
  for (const l of lines) {
    if (!adj.has(l.p1Id)) adj.set(l.p1Id, []);
    if (!adj.has(l.p2Id)) adj.set(l.p2Id, []);
    adj.get(l.p1Id)!.push({ lineId: l.id, other: l.p2Id });
    adj.get(l.p2Id)!.push({ lineId: l.id, other: l.p1Id });
  }
  const usedLines = new Set<string>();
  const loops: string[][] = [];
  for (const line of lines) {
    if (usedLines.has(line.id)) continue;
    const path: string[] = [line.p1Id];
    let cur = line.p2Id;
    const used = new Set<string>([line.id]);
    while (cur !== path[0]) {
      path.push(cur);
      const nbrs = (adj.get(cur) ?? []).filter((n) => !used.has(n.lineId));
      if (!nbrs.length) break;
      const next = nbrs.find((n) => n.other === path[0]) ?? nbrs[0];
      used.add(next.lineId);
      cur = next.other;
    }
    if (cur === path[0] && path.length >= 3) {
      for (const lid of used) usedLines.add(lid);
      loops.push(path);
    }
  }
  return loops;
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

function sampleArcPoints(
  center: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
  maxSegAngle = Math.PI / 24,
): { x: number; y: number }[] {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  if (r < 1e-8) return [start, end];
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1raw = Math.atan2(end.y - center.y, end.x - center.x);
  // Arc semantics in store/solver are CCW from start -> end.
  let sweep = a1raw - a0;
  if (sweep < 0) sweep += Math.PI * 2;
  const segs = Math.max(2, Math.ceil(sweep / maxSegAngle));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (sweep * i) / segs;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

function planeMatrix(plane: string): THREE.Matrix4 {
  if (plane === 'xz') {
    return new THREE.Matrix4().set(
      1, 0, 0, 0,
      0, 0, 1, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    );
  }
  if (plane === 'yz') {
    return new THREE.Matrix4().set(
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    );
  }
  return new THREE.Matrix4();
}

function buildGeos(sd: any, plane: string, height: number, reverse: boolean, symmetric: boolean, startOffset: number, planeOffset = 0): THREE.BufferGeometry[] {
  if (!sd?.points?.length) return [];
  const ptMap = new Map<string, { x: number; y: number }>(sd.points.map((p: any) => [p.id, p]));
  const matrix = planeMatrix(plane);
  const applyT = (geo: THREE.BufferGeometry, h: number) => {
    if (symmetric) geo.translate(0, 0, -h / 2);
    else if (reverse) geo.applyMatrix4(new THREE.Matrix4().makeScale(1, 1, -1));
    if (startOffset) geo.translate(0, 0, startOffset);
    if (planeOffset) geo.translate(0, 0, planeOffset);
    geo.applyMatrix4(matrix);
    return geo;
  };
  const result: THREE.BufferGeometry[] = [];
  for (const loop of findClosedLoops(sd.lines ?? [])) {
    const pts = loop.map((id: string) => ptMap.get(id)).filter(Boolean) as { x: number; y: number }[];
    if (pts.length < 3) continue;
    try {
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
      result.push(applyT(new THREE.ExtrudeGeometry(shape, { depth: Math.abs(height), bevelEnabled: false }), Math.abs(height)));
    } catch { /* skip */ }
  }
  for (const circ of sd.circles ?? []) {
    const c = ptMap.get(circ.centerId);
    if (!c) continue;
    try {
      const shape = new THREE.Shape();
      shape.absarc(c.x, c.y, circ.radius, 0, Math.PI * 2, false);
      result.push(applyT(new THREE.ExtrudeGeometry(shape, { depth: Math.abs(height), bevelEnabled: false }), Math.abs(height)));
    } catch { /* skip */ }
  }
  return result;
}

function crossSection(geometry: THREE.BufferGeometry, planeNormal: THREE.Vector3, planeD: number, sketchPlane: string): Seg2D[] {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const idx = geometry.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const segs: Seg2D[] = [];

  const getV = (tri: number, v: number): THREE.Vector3 => {
    const i = idx ? idx.getX(tri * 3 + v) : tri * 3 + v;
    return new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  };

  const project = (p: THREE.Vector3): { x: number; y: number } => {
    switch (sketchPlane) {
      case 'xz': return { x: p.x, y: p.z };
      case 'yz': return { x: p.y, y: p.z };
      default:   return { x: p.x, y: p.y };
    }
  };

  for (let t = 0; t < triCount; t++) {
    const a = getV(t, 0), b = getV(t, 1), c = getV(t, 2);
    const da = planeNormal.dot(a) - planeD;
    const db = planeNormal.dot(b) - planeD;
    const dc = planeNormal.dot(c) - planeD;

    const pts: THREE.Vector3[] = [];
    if (da * db < 0) { const tt = da / (da - db); pts.push(a.clone().lerp(b, tt)); }
    if (db * dc < 0) { const tt = db / (db - dc); pts.push(b.clone().lerp(c, tt)); }
    if (dc * da < 0) { const tt = dc / (dc - da); pts.push(c.clone().lerp(a, tt)); }
    if (Math.abs(da) < 1e-6) pts.push(a.clone());
    if (Math.abs(db) < 1e-6) pts.push(b.clone());
    if (Math.abs(dc) < 1e-6) pts.push(c.clone());

    if (pts.length >= 2) {
      const p1 = project(pts[0]), p2 = project(pts[1]);
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      if (dx * dx + dy * dy > 1e-10) segs.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    }
  }
  return segs;
}

function getPlaneNormalAndD(plane: string, offset = 0): { normal: THREE.Vector3; d: number } {
  switch (plane) {
    case 'xz': return { normal: new THREE.Vector3(0, 1, 0), d: offset };
    case 'yz': return { normal: new THREE.Vector3(1, 0, 0), d: offset };
    default:   return { normal: new THREE.Vector3(0, 0, 1), d: offset };
  }
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
    constraints,
    selection,
    statusMessage,
    addPoint,
    addLine,
    addCircle,
    addArc,
    applyConstraint,
    toggleSelect,
    clearSelection,
    deleteSelected,
    findNearestPoint,
    findNearestEntity,
    setStatusMessage,
    dragPoint,
    pendingConstraintType,
    clearPendingConstraintSelection,
    pendingDimensionInput,
    submitDimensionInput,
    cancelDimensionInput,
    requestEditDimension,
    updateConstraintParams,
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
  const dofCacheRef = useRef<{
    pointDoF: Map<string, number>;
    lineDoF: Map<string, number>;
    arcDoF: Map<string, number>;
    circleDoF: Map<string, number>;
  }>({
    pointDoF: new Map(),
    lineDoF: new Map(),
    arcDoF: new Map(),
    circleDoF: new Map(),
  });

  // Drawing state
  const [drawPts, setDrawPts] = useState<{ x: number; y: number }[]>([]);
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

  const isDrawingTool = (cmd: string | null) =>
    cmd === 'line' || cmd === 'polyline' || cmd === 'circle' || cmd === 'arc' || cmd === 'rectangle';
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
        const samples = sampleArcPoints({ x: c.x, y: c.y }, { x: s.x, y: s.y }, { x: e.x, y: e.y }, Math.PI / 36);
        if (samples.every((pt) => inside(pt.x, pt.y))) {
          inBox.push({ type: 'arc', id: aItem.id });
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
    [screenToWorld, points, lines, circles, arcs, constraints, isProtectedOriginFixConstraint]
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
      const snap = snapWorld(world.x, world.y);
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
          if (!pendingConstraintType) setDraggingPointId(nearPointId);
          toggleSelect({ type: 'point', id: nearPointId }, multiSelect);
          if (!pendingConstraintType) (e.target as Element).setPointerCapture?.(e.pointerId);
          tryApplyPendingConstraint();
          return;
        }
        const entity = findNearestEntity(world.x, world.y, hitThreshold);
        if (entity) {
          // Clicking a curve/line should select that entity directly.
          // Point dragging is only started when a point is explicitly hit.
          toggleSelect(entity, multiSelect);
          tryApplyPendingConstraint();
        } else {
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
          const startSnap = findNearestPoint(drawPts[0].x, drawPts[0].y, 0.01);
          const startId = startSnap || addPoint(drawPts[0].x, drawPts[0].y);
          const endId = snap.snapped || addPoint(snap.x, snap.y);
          addLine(startId, endId);
          setDrawPts([]);
        }
      } else if (activeCommand === 'polyline') {
        if (drawPts.length === 0) {
          setDrawPts([snap]);
        } else {
          const prev = drawPts[drawPts.length - 1];
          const existPrev = findNearestPoint(prev.x, prev.y, 0.01);
          const prevId = existPrev || addPoint(prev.x, prev.y);
          const endId = snap.snapped || addPoint(snap.x, snap.y);
          addLine(prevId, endId);
          setDrawPts([...drawPts, snap]);
        }
      } else if (activeCommand === 'circle') {
        if (drawPts.length === 0) {
          setDrawPts([snap]);
        } else {
          const center = drawPts[0];
          const radius = Math.sqrt((snap.x - center.x) ** 2 + (snap.y - center.y) ** 2);
          if (radius > 0.01) {
            const existCenter = findNearestPoint(center.x, center.y, 0.01);
            const centerId = existCenter || addPoint(center.x, center.y);
            addCircle(centerId, radius);
          }
          setDrawPts([]);
        }
      } else if (activeCommand === 'arc') {
        if (drawPts.length === 0) {
          setDrawPts([snap]);
        } else if (drawPts.length === 1) {
          setDrawPts([...drawPts, snap]);
      } else {
          const center = drawPts[0];
          const startPt = drawPts[1];
          const radius = Math.sqrt((startPt.x - center.x) ** 2 + (startPt.y - center.y) ** 2);
          if (radius > 0.01) {
            const angle = Math.atan2(snap.y - center.y, snap.x - center.x);
            const endX = center.x + radius * Math.cos(angle);
            const endY = center.y + radius * Math.sin(angle);

            const existCenter = findNearestPoint(center.x, center.y, 0.01);
            const centerId = existCenter || addPoint(center.x, center.y);
            const existStart = findNearestPoint(startPt.x, startPt.y, 0.01);
            const startId = existStart || addPoint(startPt.x, startPt.y);
            const endId = addPoint(endX, endY);
            addArc(centerId, startId, endId);
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
            const p1 = addPoint(c1.x, c1.y);
            const p2 = addPoint(c2.x, c1.y);
            const p3 = addPoint(c2.x, c2.y);
            const p4 = addPoint(c1.x, c2.y);
            const l1 = addLine(p1, p2);
            const l2 = addLine(p2, p3);
            const l3 = addLine(p3, p4);
            const l4 = addLine(p4, p1);

            // Auto-constrain rectangle sides: top/bottom horizontal, left/right vertical.
            clearSelection();
            toggleSelect({ type: 'line', id: l1 }, false);
            applyConstraint('horizontal');
            toggleSelect({ type: 'line', id: l3 }, false);
            applyConstraint('horizontal');
            toggleSelect({ type: 'line', id: l2 }, false);
            applyConstraint('vertical');
            toggleSelect({ type: 'line', id: l4 }, false);
            applyConstraint('vertical');
            clearSelection();
          }
          setDrawPts([]);
        }
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
      addPoint,
      addLine,
      addCircle,
      addArc,
      applyConstraint,
      findNearestPoint,
      findNearestEntity,
      constraints,
      isProtectedOriginFixConstraint,
      pendingConstraintType,
      lines,
      points,
      isMultiSelectEvent,
      toggleSelect,
      clearSelection,
      clearPendingConstraintSelection,
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
      const snap = snapWorld(world.x, world.y);
      setSnappedCursor(snap);
      setSnapIndicator(snap.snapped);

      if (draggingDimension) {
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

      if (draggingPointId) {
        dragPoint(draggingPointId, world.x, world.y);
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
    [isPanning, screenToWorld, snapWorld, draggingDimension, updateConstraintParams, draggingPointId, dragPoint, boxSelect, collectBoxSelection, activeCommand, zoom, findNearestEntity]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (isPanning) {
        setIsPanning(false);
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      }
      if (draggingPointId) {
        setDraggingPointId(null);
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
    [isPanning, draggingPointId, draggingDimension, boxSelect, collectBoxSelection, clearSelection]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
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

  const handleDoubleClick = useCallback(() => {
    if (activeCommand === 'polyline' && drawPts.length > 0) {
      setDrawPts([]);
      setStatusMessage('Polyline finished');
    }
  }, [activeCommand, drawPts, setStatusMessage]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
  }, [clearSelection, clearPendingConstraintSelection, deleteSelected, selection.length, setActiveCommand, setStatusMessage]);

  useEffect(() => {
    setDrawPts([]);
  }, [activeCommand]);

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
    // DoF estimation is expensive (many solver calls). Freeze during drag
    // for smooth interaction, then refresh on release.
    if (draggingPointId) return dofCacheRef.current;

    const pointById = new Map(points.map((p) => [p.id, p]));
    const constraintsInput = constraints as SolverConstraint[];
    const basePoints = points as SolverPoint[];
    const linesInput = lines as SolverLine[];
    const circlesInput = circles as SolverCircle[];
    const arcsInput = arcs as SolverArc[];
    const PERTURB = 0.2;
    const MOVED_EPS = 1e-4;
    const DEP_EPS = 1e-5;
    const constrainedPointIds = new Set<string>();
    for (const cn of constraints) {
      for (const eid of cn.entityIds) {
        if (pointById.has(eid)) {
          constrainedPointIds.add(eid);
          continue;
        }
        const l = lines.find((x) => x.id === eid);
        if (l) {
          constrainedPointIds.add(l.p1Id);
          constrainedPointIds.add(l.p2Id);
          continue;
        }
        const c = circles.find((x) => x.id === eid);
        if (c) {
          constrainedPointIds.add(c.centerId);
          continue;
        }
        const a = arcs.find((x) => x.id === eid);
        if (a) {
          constrainedPointIds.add(a.centerId);
          constrainedPointIds.add(a.startId);
          constrainedPointIds.add(a.endId);
        }
      }
    }

    const gramSchmidtRank = (vectors: number[][]): number => {
      const basis: number[][] = [];
      for (const v0 of vectors) {
        let v = [...v0];
        for (const b of basis) {
          let dotVB = 0;
          let dotBB = 0;
          for (let i = 0; i < v.length; i++) {
            dotVB += v[i] * b[i];
            dotBB += b[i] * b[i];
          }
          if (dotBB > 0) {
            const s = dotVB / dotBB;
            for (let i = 0; i < v.length; i++) v[i] -= s * b[i];
          }
        }
        let norm2 = 0;
        for (const x of v) norm2 += x * x;
        if (norm2 > DEP_EPS) basis.push(v);
      }
      return basis.length;
    };

    const estimateEntityDoF = (entityPointIds: string[]): number => {
      const uniq = [...new Set(entityPointIds)];
      if (uniq.length === 0) return 0;
      // If no constraints touch this entity's points, it is fully free.
      if (!uniq.some((pid) => constrainedPointIds.has(pid))) return uniq.length * 2;
      const baseIdxById = new Map(basePoints.map((p, i) => [p.id, i]));
      const vectors: number[][] = [];

      for (const pid of uniq) {
        const p = pointById.get(pid);
        if (!p) continue;
        for (const axis of ['x', 'y'] as const) {
          const tx = axis === 'x' ? p.x + PERTURB : p.x;
          const ty = axis === 'y' ? p.y + PERTURB : p.y;
          const solved = solveConstraints(
            basePoints,
            linesInput,
            circlesInput,
            arcsInput,
            constraintsInput,
            { pointId: pid, x: tx, y: ty, strength: 0.25 }
          );

          const vec: number[] = [];
          let moved = false;
          for (const eid of uniq) {
            const idx = baseIdxById.get(eid);
            if (idx === undefined) continue;
            const b = basePoints[idx];
            const s = solved.points[idx];
            const dx = s.x - b.x;
            const dy = s.y - b.y;
            vec.push(dx, dy);
            if (Math.hypot(dx, dy) > MOVED_EPS) moved = true;
          }
          if (moved && solved.constraintEnergy < 1e-4) vectors.push(vec);
        }
      }
      return gramSchmidtRank(vectors);
    };

    const pointDoF = new Map<string, number>();
    for (const p of points) pointDoF.set(p.id, estimateEntityDoF([p.id]));

    const lineDoF = new Map<string, number>();
    for (const l of lines) lineDoF.set(l.id, estimateEntityDoF([l.p1Id, l.p2Id]));

    const arcDoF = new Map<string, number>();
    for (const a of arcs) arcDoF.set(a.id, estimateEntityDoF([a.centerId, a.startId, a.endId]));

    const circleDoF = new Map<string, number>();
    for (const c of circles) {
      // Circle has center translation dof from center point + radius dof unless constrained.
      const centerDof = estimateEntityDoF([c.centerId]);
      const hasRadiusConstraint = constraints.some(
        (cn) => (cn.type === 'radius' || cn.type === 'arcRadius') && cn.entityIds.includes(c.id)
      );
      const radiusDof = hasRadiusConstraint ? 0 : 1;
      circleDoF.set(c.id, centerDof + radiusDof);
    }

    const next = { pointDoF, lineDoF, arcDoF, circleDoF };
    dofCacheRef.current = next;
    return next;
  }, [points, lines, circles, arcs, constraints, draggingPointId]);

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
  const isSketchFullyConstrained = useMemo(() => {
    const pointOk = points.every((p) => (dofState.pointDoF.get(p.id) ?? 0) === 0);
    const lineOk = lines.every((l) => (dofState.lineDoF.get(l.id) ?? 0) === 0);
    const arcOk = arcs.every((a) => (dofState.arcDoF.get(a.id) ?? 0) === 0);
    const circleOk = circles.every((c) => (dofState.circleDoF.get(c.id) ?? 0) === 0);
    return pointOk && lineOk && arcOk && circleOk;
  }, [points, lines, arcs, circles, dofState]);

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
            dims.push({
              id: c.id, type: c.type,
              x1: center.x + labelDx, y1: center.y + labelDy,
              x2: center.x + circ.radius + labelDx, y2: center.y + labelDy,
              labelX: center.x + circ.radius / 2 + labelDx, labelY: center.y + off * 0.5 + labelDy,
              text: `R${c.params.radius.toFixed(2)}`,
              offsetDir: 'radial',
              dragAxisX: 1,
              dragAxisY: 0,
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
              dragAxisX: rdx / rlen,
              dragAxisY: rdy / rlen,
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

  const arcTempRadius =
    drawPts.length >= 1 && activeCommand === 'arc'
      ? drawPts.length === 1
        ? Math.sqrt(
            (snappedCursor.x - drawPts[0].x) ** 2 +
              (snappedCursor.y - drawPts[0].y) ** 2
          )
        : Math.sqrt(
            (drawPts[1].x - drawPts[0].x) ** 2 +
              (drawPts[1].y - drawPts[0].y) ** 2
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
    const arcPts = sampleArcPoints(center, startPt, end);
    if (arcPts.length < 2) return '';
    return `M ${arcPts[0].x} ${arcPts[0].y} L ${arcPts.slice(1).map((p) => `${p.x} ${p.y}`).join(' L ')}`;
  }, [activeCommand, drawPts, snappedCursor]);

  const renderArcPath = useCallback(
    (arcItem: { centerId: string; startId: string; endId: string; id: string }) => {
      const center = points.find((p) => p.id === arcItem.centerId);
      const start = points.find((p) => p.id === arcItem.startId);
      const end = points.find((p) => p.id === arcItem.endId);
      if (!center || !start || !end) return null;
      const arcPts = sampleArcPoints(
        { x: center.x, y: center.y },
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
      );
      if (arcPts.length < 2) return null;
      const color = getEntityColor('arc', arcItem.id);
      const sw = 2 / zoom;
      return (
        <path
          key={arcItem.id}
          d={`M ${arcPts[0].x} ${arcPts[0].y} L ${arcPts.slice(1).map((p) => `${p.x} ${p.y}`).join(' L ')}`}
          stroke={color}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    },
    [points, zoom, getEntityColor]
  );

  const [crossSectionTris, setCrossSectionTris] = useState<
    { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }[]
  >([]);

  // B-Rep-based background section: intersect solids with sketch plane (thin slab).
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!activeSketchId) {
        if (!cancelled) { setCrossSectionTris([]); }
        return;
      }
      if (!isCADReady()) {
        try { await initCAD(); } catch { /* ignore */ }
      }
      const activeSketch = features.find((f) => f.id === activeSketchId) as SketchFeature | undefined;
      if (!activeSketch) {
        if (!cancelled) { setCrossSectionTris([]); }
        return;
      }
      const sketchMap = new Map<string, SketchFeature>(
        features.filter((f): f is SketchFeature => f.type === 'sketch').map((f) => [f.id, f]),
      );
      const featureInputs: FeatureInput[] = [];
      for (const feat of features) {
        if (feat.type !== 'extrude' && feat.type !== 'cut') continue;
        const ef = feat as ExtrudeFeature | CutFeature;
        const height = Math.max(
          Number(feat.type === 'extrude' ? (ef as ExtrudeFeature).parameters.height : (ef as CutFeature).parameters.depth) || 10,
          0.001,
        );
        const sketch = sketchMap.get(ef.parameters.sketchId);
        const sd = sketch?.parameters?.sketchData;
        if (!sd) continue;
        const sPlane = sketch?.parameters?.plane ?? 'xy';
        const sOff = Number(sketch?.parameters?.planeOffset) || 0;
        const planeRef = sketch?.parameters?.planeRef ?? null;
        const { reverse, symmetric, startOffset } = ef.parameters;
        featureInputs.push({
          id: feat.id,
          name: feat.name,
          type: feat.type as 'extrude' | 'cut',
          sketchData: sd as any,
          plane: sPlane,
          height,
          reverse: !!reverse,
          symmetric: !!symmetric,
          startOffset: Number(startOffset) || 0,
          planeOffset: sOff,
          planeRef,
        });
      }
      if (activeSketch.parameters.planeRef?.type === 'face') {
        if (!cancelled) setCrossSectionTris([]);
        return;
      }
      const skPlane = activeSketch.parameters.plane;
      const skOff = Number(activeSketch.parameters.planeOffset) || 0;
      const tris = buildSectionTriangles2D(featureInputs, skPlane, skOff);
      if (cancelled) return;
      setCrossSectionTris(tris);
    };
    run();
    return () => { cancelled = true; };
  }, [features, activeSketchId]);

  // Closed-loop region detection with support for nested holes
  const sketchRegions = useMemo(() => {
    const ptMap = new Map(points.map((p) => [p.id, p]));
    const loops: Loop2D[] = [];

    // Build mixed edge graph from all supported segments that participate in loops
    const edges: LoopEdge[] = [];
    for (const l of lines) {
      const p1 = ptMap.get(l.p1Id), p2 = ptMap.get(l.p2Id);
      if (!p1 || !p2) continue;
      edges.push({
        id: `line_${l.id}`,
        a: l.p1Id,
        b: l.p2Id,
        path: [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }],
      });
    }
    for (const a of arcs) {
      const c = ptMap.get(a.centerId);
      const s = ptMap.get(a.startId);
      const e = ptMap.get(a.endId);
      if (!c || !s || !e) continue;
      const path = sampleArcPoints({ x: c.x, y: c.y }, { x: s.x, y: s.y }, { x: e.x, y: e.y });
      if (path.length < 2) continue;
      edges.push({
        id: `arc_${a.id}`,
        a: a.startId,
        b: a.endId,
        path,
      });
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

      while (curNode !== startNode) {
        const nbrs = (adj.get(curNode) ?? []).filter((n) => !thisLoopUsed.has(n.edgeId));
        if (!nbrs.length) break;
        // Prefer continuing without immediate back-track when possible
        const next = nbrs.find((n) => n.other !== prevNode) ?? nbrs[0];
        const seg = edgeById.get(next.edgeId);
        if (!seg) break;
        thisLoopUsed.add(seg.id);

        const forward = seg.a === curNode;
        const segPts = forward ? seg.path : [...seg.path].reverse();
        // Stitch without duplicating junction point
        pathPts.push(...segPts.slice(1));

        prevNode = curNode;
        curNode = next.other;
      }

      if (curNode === startNode && pathPts.length >= 3) {
        for (const id of thisLoopUsed) usedEdges.add(id);
        // Remove duplicate closing point if present
        const first = pathPts[0], last = pathPts[pathPts.length - 1];
        const pts = (Math.hypot(first.x - last.x, first.y - last.y) < 1e-8)
          ? pathPts.slice(0, -1)
          : pathPts;
        const meta = computeLoopMeta(pts, `mixed_${loopIdx++}`);
        if (meta) loops.push(meta);
      }
    }

    // Full circles as closed loops
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const center = ptMap.get(c.centerId);
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
    const byId = new Map(loops.map((l) => [l.id, l]));
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
  }, [points, lines, arcs, circles]);

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
        circle: 'Click center, then drag radius',
        arc: 'Click center, start point, end point',
        rectangle: 'Click first corner, then opposite corner',
      }[activeCommand] || ''
    : 'Select entities or choose a tool';

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-10 overflow-hidden"
      style={{ background: COLORS.bg, cursor: isDrawingTool(activeCommand) ? 'crosshair' : 'default' }}
    >
      <svg
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleSketchContextMenu}
        style={{ display: 'block', width: '100%', height: '100%' }}
      >
        {/* World-space group (Y flipped) */}
        <g transform={transform}>
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

          {/* Cross-section of existing solids with sketch plane */}
          {crossSectionTris.map((t, i) => (
            <polygon
              key={`xst${i}`}
              points={`${t.x1},${t.y1} ${t.x2},${t.y2} ${t.x3},${t.y3}`}
              fill="#9ca3af"
              fillOpacity={0.26}
              stroke="none"
            />
          ))}

          {/* Filled sketch regions (closed loops with nested holes) */}
          {sketchRegions.map((r, i) => (
            <path
              key={`region_${i}`}
              d={r.path}
              fill={isSketchFullyConstrained ? COLORS.constrained : COLORS.entity}
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
              />
            );
          })}

          {/* Arcs */}
          {arcs.map(renderArcPath)}

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
          const s1 = worldToScreen(dim.x1, dim.y1);
          const s2 = worldToScreen(dim.x2, dim.y2);
          const sLabel = worldToScreen(dim.labelX, dim.labelY);
          const dimColor = isSelected('constraint', dim.id) ? COLORS.entitySelected : COLORS.constraint;
          const arrowSize = 6;
          const dx = s2.x - s1.x, dy = s2.y - s1.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux = dx / len, uy = dy / len;

          return (
            <g key={`dim_${dim.id}`}>
              {/* Dimension line */}
              <line x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y}
                stroke={dimColor} strokeWidth={1} opacity={0.8}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSelect({ type: 'constraint', id: dim.id }, isMultiSelectEvent(e));
                }}
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
                onPointerDown={(e) => {
                  e.stopPropagation();
                  toggleSelect({ type: 'constraint', id: dim.id }, isMultiSelectEvent(e));
                  const c = constraints.find((cc) => cc.id === dim.id);
                  const baseDx = Number(c?.params?.labelDx ?? 0);
                  const baseDy = Number(c?.params?.labelDy ?? 0);
                  const world = screenToWorld(e.clientX, e.clientY);
                  setDraggingDimension({
                    id: dim.id,
                    startX: world.x,
                    startY: world.y,
                    baseDx,
                    baseDy,
                    axisX: dim.dragAxisX,
                    axisY: dim.dragAxisY,
                  });
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                }}
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
                onPointerDown={(e) => {
                  e.stopPropagation();
                  toggleSelect({ type: 'constraint', id: dim.id }, isMultiSelectEvent(e));
                  const c = constraints.find((cc) => cc.id === dim.id);
                  const baseDx = Number(c?.params?.labelDx ?? 0);
                  const baseDy = Number(c?.params?.labelDy ?? 0);
                  const world = screenToWorld(e.clientX, e.clientY);
                  setDraggingDimension({
                    id: dim.id,
                    startX: world.x,
                    startY: world.y,
                    baseDx,
                    baseDy,
                    axisX: dim.dragAxisX,
                    axisY: dim.dragAxisY,
                  });
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                }}
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
