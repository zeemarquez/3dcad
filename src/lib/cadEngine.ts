import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, draw, drawCircle, drawRectangle, drawProjection, Plane, revolution, type Shape3D } from "replicad";
import type { GeometricSelectionRef, SketchFeature } from "../store/useCadStore";
import { cross3, normalize3, getSketchPlaneBasis, worldToSketch2D } from "./sketchPlaneBasis";
import { sampleArcPoints } from "./sketchArcPoints";
import { mergeCoincidentSketchVertices, pickNextEdgeInFace } from "./sketchLoopDetection";
import type { ShapeMesh } from "replicad";

let _ready = false;
let _initPromise: Promise<void> | null = null;

export async function initCAD(): Promise<void> {
  if (_ready) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const OC = await (opencascade as any)({
      locateFile: () => opencascadeWasm,
    });
    setOC(OC);
    _ready = true;
  })();
  return _initPromise;
}

export function isCADReady(): boolean {
  return _ready;
}

// ---------- Types ----------

export interface FaceGroupInfo {
  start: number;
  count: number;
  faceId: number;
}

export interface SolidMeshData {
  featureId: string;
  featureName: string;
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  faceGroups: FaceGroupInfo[];
  edgeVertices: Float32Array; // flat [x,y,z, x,y,z, ...] pairs for line segments
  edgeGroupStarts: number[];  // start index in edgeVertices for each topological edge
}

// ---------- Sketch → replicad Drawing ----------

interface SketchPoint { id: string; x: number; y: number }
interface SketchLine  { id: string; p1Id: string; p2Id: string; auxiliary?: boolean }
interface SketchCircle { id: string; centerId: string; radius: number; auxiliary?: boolean }
interface SketchArc {
  id: string;
  centerId: string;
  startId: string;
  endId: string;
  complementaryArc?: boolean;
  auxiliary?: boolean;
}

interface SketchData {
  points: SketchPoint[];
  lines: SketchLine[];
  circles?: SketchCircle[];
  arcs?: SketchArc[];
  constraints?: { type: string; entityIds: string[] }[];
}
interface LoopEdge {
  id: string;
  a: string;
  b: string;
  kind: "line" | "arc";
  via?: { x: number; y: number }; // for arc: an interior point on the arc
  path: { x: number; y: number }[]; // includes both endpoints
}

interface SketchRegionLoop {
  id: string;
  areaAbs: number;
  centroid: { x: number; y: number };
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  polygon: { x: number; y: number }[];
  makeDrawing: () => any;
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

function findClosedMixedLoops(
  sd: SketchData,
  merged: ReturnType<typeof mergeCoincidentSketchVertices>
): {
  start: { x: number; y: number };
  segments: { kind: "line" | "arc"; end: { x: number; y: number }; via?: { x: number; y: number }; polyPath: { x: number; y: number }[] }[];
}[] {
  const { canonical, mergedPtMap: ptMap } = merged;
  const edges: LoopEdge[] = [];

  for (const l of sd.lines ?? []) {
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
      kind: "line",
      path: [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }],
    });
  }

  for (const a of sd.arcs ?? []) {
    if (a.auxiliary) continue;
    const ca = canonical(a.centerId);
    const sa = canonical(a.startId);
    const ea = canonical(a.endId);
    const c = ptMap.get(ca);
    const s = ptMap.get(sa);
    const e = ptMap.get(ea);
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
    // Interior point that defines the exact circular arc branch in replicad.
    const via = path[Math.floor(path.length / 2)];
    edges.push({ id: `arc_${a.id}`, a: sa, b: ea, kind: "arc", via, path });
  }

  const adj = new Map<string, { edgeId: string; other: string }[]>();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push({ edgeId: e.id, other: e.b });
    adj.get(e.b)!.push({ edgeId: e.id, other: e.a });
  }

  const byId = new Map(edges.map((e) => [e.id, e]));
  const used = new Set<string>();
  const loops: { start: { x: number; y: number }; segments: { kind: "line" | "arc"; end: { x: number; y: number }; via?: { x: number; y: number }; polyPath: { x: number; y: number }[] }[] }[] = [];

  for (const seed of edges) {
    if (used.has(seed.id)) continue;
    const startNode = seed.a;
    let curNode = seed.b;
    let prevNode = seed.a;
    const thisUsed = new Set<string>([seed.id]);
    const ordered: { seg: LoopEdge; forward: boolean }[] = [{ seg: seed, forward: true }];
    let incomingEdgeId = seed.id;

    while (curNode !== startNode) {
      const nbrs = (adj.get(curNode) ?? []).filter((n) => !thisUsed.has(n.edgeId));
      if (!nbrs.length) break;
      const next = pickNextEdgeInFace(curNode, prevNode, incomingEdgeId, nbrs, ptMap, byId) ?? nbrs[0];
      const seg = byId.get(next.edgeId);
      if (!seg) break;
      thisUsed.add(seg.id);
      const forward = seg.a === curNode;
      ordered.push({ seg, forward });
      incomingEdgeId = next.edgeId;
      prevNode = curNode;
      curNode = next.other;
    }

    if (curNode === startNode && ordered.length >= 2) {
      for (const id of thisUsed) used.add(id);
      const firstSeg = ordered[0];
      const start = firstSeg.forward ? firstSeg.seg.path[0] : firstSeg.seg.path[firstSeg.seg.path.length - 1];
      const segments = ordered.map(({ seg, forward }) => ({
        kind: seg.kind,
        end: forward ? seg.path[seg.path.length - 1] : seg.path[0],
        via: seg.via,
        polyPath: forward ? seg.path : [...seg.path].reverse(),
      }));
      loops.push({ start, segments });
    }
  }

  return loops;
}

function buildSketchRegionLoops(sd: SketchData): SketchRegionLoop[] {
  const merged = mergeCoincidentSketchVertices(sd.points ?? [], sd.constraints ?? []);
  const loops: SketchRegionLoop[] = [];
  const mixed = findClosedMixedLoops(sd, merged);

  for (let i = 0; i < mixed.length; i++) {
    const loop = mixed[i];
    if (!loop.segments.length) continue;
    const poly: { x: number; y: number }[] = [loop.start];
    for (const seg of loop.segments) {
      poly.push(...seg.polyPath.slice(1));
    }
    if (poly.length < 3) continue;
    const areaAbs = Math.abs(signedArea(poly));
    if (areaAbs < 1e-8) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let cx = 0, cy = 0;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      cx += p.x; cy += p.y;
    }
    loops.push({
      id: `mixed_${i}`,
      areaAbs,
      centroid: { x: cx / poly.length, y: cy / poly.length },
      bbox: { minX, minY, maxX, maxY },
      polygon: poly,
      makeDrawing: () => {
        let d = draw([loop.start.x, loop.start.y]);
        for (const seg of loop.segments) {
          if (seg.kind === "arc" && seg.via) d = d.threePointsArcTo([seg.end.x, seg.end.y], [seg.via.x, seg.via.y]);
          else d = d.lineTo([seg.end.x, seg.end.y]);
        }
        return d.close();
      },
    });
  }

  const { canonical, mergedPtMap: ptMap } = merged;
  for (const c of sd.circles ?? []) {
    if (c.auxiliary) continue;
    const center = ptMap.get(canonical(c.centerId));
    if (!center || c.radius <= 1e-8) continue;
    const segs = 72;
    const poly: { x: number; y: number }[] = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      poly.push({ x: center.x + c.radius * Math.cos(a), y: center.y + c.radius * Math.sin(a) });
    }
    loops.push({
      id: `circle_${c.id}`,
      areaAbs: Math.PI * c.radius * c.radius,
      centroid: { x: center.x, y: center.y },
      bbox: { minX: center.x - c.radius, minY: center.y - c.radius, maxX: center.x + c.radius, maxY: center.y + c.radius },
      polygon: poly,
      makeDrawing: () => drawCircle(c.radius).translate(center.x, center.y),
    });
  }

  return loops;
}

function buildFilledRegionDrawings(sd: SketchData): any[] {
  const loops = buildSketchRegionLoops(sd);
  if (!loops.length) return [];

  const depth = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const l of loops) {
    let bestParent: SketchRegionLoop | null = null;
    for (const cand of loops) {
      if (cand.id === l.id) continue;
      if (cand.areaAbs <= l.areaAbs) continue;
      if (
        l.bbox.minX < cand.bbox.minX || l.bbox.maxX > cand.bbox.maxX ||
        l.bbox.minY < cand.bbox.minY || l.bbox.maxY > cand.bbox.maxY
      ) continue;
      if (!pointInPolygon(l.centroid, cand.polygon)) continue;
      if (!bestParent || cand.areaAbs < bestParent.areaAbs) bestParent = cand;
    }
    parent.set(l.id, bestParent?.id ?? null);
    depth.set(l.id, bestParent ? ((depth.get(bestParent.id) ?? 0) + 1) : 0);
  }

  const drawings: any[] = [];
  for (const outer of loops) {
    const d = depth.get(outer.id) ?? 0;
    if (d % 2 !== 0) continue;
    let region = outer.makeDrawing();
    const holes = loops.filter((h) => (parent.get(h.id) === outer.id) && ((depth.get(h.id) ?? 0) === d + 1));
    for (const hole of holes) {
      region = region.cut(hole.makeDrawing());
    }
    drawings.push(region);
  }
  return drawings;
}

// Replicad's XZ plane uses opposite signed offset vs this app's world-space Y convention.
// Keep app/UI offsets intuitive, and convert only at the kernel boundary.
function kernelPlaneOffset(plane: string, offset: number): number {
  if (plane === "xz") return -offset;
  return offset;
}

/** Replicad sketch plane for extrude/cut, including arbitrary face planes from planeRef. */
function getReplicadSketchPlaneForExtrude(op: {
  plane: string;
  planeOffset: number;
  planeRef?: Extract<GeometricSelectionRef, { type: "defaultPlane" | "face" | "plane" }> | null;
  height: number;
  reverse: boolean;
  symmetric: boolean;
  startOffset: number;
}): Plane {
  const effectiveHeight = Math.max(Math.abs(Number(op.height) || 0), 0.001);
  const po = Number(op.planeOffset) || 0;
  const startOffset = Number(op.startOffset) || 0;
  const ref = op.planeRef;

  if (ref?.type === "plane") {
    const pl = op.plane === "xz" || op.plane === "yz" ? op.plane : "xy";
    const sk: SketchFeature = {
      id: "__sketchPlaneRef__",
      name: "__sketchPlaneRef__",
      type: "sketch",
      parameters: { plane: pl, planeOffset: po, planeRef: ref },
    };
    const basis = getSketchPlaneBasis(sk);
    const n = basis.n;
    const u = basis.u;
    let shift = startOffset;
    if (op.symmetric) shift -= effectiveHeight / 2;
    else if (op.reverse) shift -= effectiveHeight;
    const origin: [number, number, number] = [
      basis.origin[0] + n[0] * shift,
      basis.origin[1] + n[1] * shift,
      basis.origin[2] + n[2] * shift,
    ];
    return new Plane(origin, u, n);
  }

  if (ref?.type === "face" && ref.normal) {
    const [nx, ny, nz] = ref.normal;
    const len = Math.hypot(nx, ny, nz);
    if (len >= 1e-12) {
      const n = normalize3([nx, ny, nz]);
      // Same as sketchPlaneBasis: plane position comes only from planeRef.faceOffset,
      // not sketch.parameters.planeOffset (avoids double-counting vs geoRefToPlaneAndOffset).
      let t = ref.faceOffset + startOffset;
      if (op.symmetric) t -= effectiveHeight / 2;
      else if (op.reverse) t -= effectiveHeight;
      const origin: [number, number, number] = [n[0] * t, n[1] * t, n[2] * t];
      const helper: [number, number, number] = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const u = normalize3(cross3(helper, n));
      return new Plane(origin, u, n);
    }
  }

  const plane =
    ref?.type === "defaultPlane" ? ref.name : (op.plane || "xy");
  const kb = kernelPlaneOffset(plane, po);
  let eff = kb + startOffset;
  if (op.symmetric) eff -= effectiveHeight / 2;
  else if (op.reverse) eff -= effectiveHeight;

  if (plane === "xz") {
    return new Plane([0, eff, 0], [1, 0, 0], [0, 1, 0]);
  }
  if (plane === "yz") {
    return new Plane([eff, 0, 0], [0, 1, 0], [1, 0, 0]);
  }
  return new Plane([0, 0, eff], [1, 0, 0], [0, 0, 1]);
}

/** Sketch plane placement for revolve (no extrusion-height shift — matches sketch location). */
function getReplicadSketchPlaneForRevolve(op: {
  plane: string;
  planeOffset: number;
  planeRef?: Extract<GeometricSelectionRef, { type: "defaultPlane" | "face" | "plane" }> | null;
  startOffset: number;
}): Plane {
  const po = Number(op.planeOffset) || 0;
  const startOffset = Number(op.startOffset) || 0;
  const ref = op.planeRef;

  if (ref?.type === "plane") {
    const pl = op.plane === "xz" || op.plane === "yz" ? op.plane : "xy";
    const sk: SketchFeature = {
      id: "__sketchPlaneRef__",
      name: "__sketchPlaneRef__",
      type: "sketch",
      parameters: { plane: pl, planeOffset: po, planeRef: ref },
    };
    const basis = getSketchPlaneBasis(sk);
    const n = basis.n;
    const u = basis.u;
    const shift = startOffset;
    const origin: [number, number, number] = [
      basis.origin[0] + n[0] * shift,
      basis.origin[1] + n[1] * shift,
      basis.origin[2] + n[2] * shift,
    ];
    return new Plane(origin, u, n);
  }

  if (ref?.type === "face" && ref.normal) {
    const [nx, ny, nz] = ref.normal;
    const len = Math.hypot(nx, ny, nz);
    if (len >= 1e-12) {
      const n = normalize3([nx, ny, nz]);
      const t = ref.faceOffset + startOffset;
      const origin: [number, number, number] = [n[0] * t, n[1] * t, n[2] * t];
      const helper: [number, number, number] = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const u = normalize3(cross3(helper, n));
      return new Plane(origin, u, n);
    }
  }

  const plane =
    ref?.type === "defaultPlane" ? ref.name : (op.plane || "xy");
  const kb = kernelPlaneOffset(plane, po);
  const eff = kb + startOffset;

  if (plane === "xz") {
    return new Plane([0, eff, 0], [1, 0, 0], [0, 1, 0]);
  }
  if (plane === "yz") {
    return new Plane([eff, 0, 0], [0, 1, 0], [1, 0, 0]);
  }
  return new Plane([0, 0, eff], [1, 0, 0], [0, 0, 1]);
}

function worldRevolveAxisDirection(axis: "x" | "y" | "z"): [number, number, number] {
  if (axis === "x") return [1, 0, 0];
  if (axis === "y") return [0, 1, 0];
  return [0, 0, 1];
}

function sketchToSolids(op: SketchBooleanFeatureInput): Shape3D[] {
  const sd = op.sketchData;
  if (!sd?.points?.length) return [];
  const effectiveHeight = Math.max(Math.abs(Number(op.height) || 0), 0.001);
  const rpPlane = getReplicadSketchPlaneForExtrude(op);

  const results: Shape3D[] = [];
  const regionDrawings = buildFilledRegionDrawings(sd);
  for (const drawing of regionDrawings) {
    try {
      const sketch = drawing.sketchOnPlane(rpPlane);
      const solid = sketch.extrude(effectiveHeight) as Shape3D;
      results.push(solid);
    } catch (e) {
      console.warn("Failed to build loop solid:", e);
    }
  }

  return results;
}

function sketchToRevolveSolids(op: RevolveFeatureInput): Shape3D[] {
  const sd = op.sketchData;
  if (!sd?.points?.length) return [];
  const rpPlane = getReplicadSketchPlaneForRevolve({
    plane: op.plane,
    planeOffset: op.planeOffset,
    planeRef: op.planeRef,
    startOffset: Number(op.startOffset) || 0,
  });
  const rawAngle = Math.abs(Number(op.angle) || 360);
  const angleDeg = Math.min(Math.max(rawAngle, 0.001), 360);
  const axisDir = worldRevolveAxisDirection(op.axis);

  const results: Shape3D[] = [];
  const regionDrawings = buildFilledRegionDrawings(sd);
  for (const drawing of regionDrawings) {
    let sk: any = null;
    let fc: any = null;
    try {
      sk = drawing.sketchOnPlane(rpPlane);
      fc = sk.face();
      const solid = revolution(fc, sk.defaultOrigin, axisDir, angleDeg) as Shape3D;
      results.push(solid);
    } catch (e) {
      console.warn("Failed to build revolve solid:", e);
    } finally {
      try {
        fc?.delete?.();
      } catch {
        /* ignore */
      }
      try {
        sk?.delete?.();
      } catch {
        /* ignore */
      }
    }
  }

  return results;
}

// ---------- Mesh extraction ----------

function extractMeshData(
  shape: Shape3D,
  featureId: string,
  featureName: string,
): SolidMeshData {
  const meshData: ShapeMesh = shape.mesh({ tolerance: 0.1, angularTolerance: 0.1 });

  const vertices = new Float32Array(meshData.vertices);
  const normals = new Float32Array(meshData.normals);
  const triangles = new Uint32Array(meshData.triangles);
  const faceGroups: FaceGroupInfo[] = meshData.faceGroups.map((g: any) => ({
    start: g.start,
    count: g.count,
    faceId: g.faceId,
  }));

  const edgeData = shape.meshEdges({ tolerance: 0.1, angularTolerance: 0.1 });
  const edgeVerts: number[] = [];
  const edgeGroupStarts: number[] = [];

  if (edgeData && edgeData.lines) {
    // lines[] is flat [x,y,z, x,y,z, ...] — pairs of points forming line segments.
    // edgeGroups[i].start and .count are in units of POINTS (not flat-array indices),
    // so lines[start*3 .. (start+count)*3-1] is one edge's points.
    const lineCoords: number[] = Array.isArray(edgeData.lines) ? edgeData.lines : [];

    if (edgeData.edgeGroups && Array.isArray(edgeData.edgeGroups)) {
      for (const eg of edgeData.edgeGroups) {
        const start = (eg as any).start as number;  // index of first point
        const count = (eg as any).count as number;  // number of points for this edge
        edgeGroupStarts.push(edgeVerts.length / 3);
        // Each pair of consecutive points is one line segment
        for (let pi = start; pi < start + count - 1; pi++) {
          edgeVerts.push(
            lineCoords[pi * 3],     lineCoords[pi * 3 + 1],     lineCoords[pi * 3 + 2],
            lineCoords[(pi+1)*3],   lineCoords[(pi+1)*3 + 1],   lineCoords[(pi+1)*3 + 2],
          );
        }
      }
    } else {
      // Fallback: treat as raw segment pairs [A,B, A,B, ...]
      for (let i = 0; i < lineCoords.length - 3; i += 6) {
        edgeVerts.push(
          lineCoords[i], lineCoords[i + 1], lineCoords[i + 2],
          lineCoords[i + 3], lineCoords[i + 4], lineCoords[i + 5],
        );
      }
    }
  }

  return {
    featureId,
    featureName,
    vertices,
    normals,
    triangles,
    faceGroups,
    edgeVertices: new Float32Array(edgeVerts),
    edgeGroupStarts,
  };
}

// ---------- Main build function ----------

export interface SketchBooleanFeatureInput {
  id: string;
  name: string;
  type: "extrude" | "cut";
  sketchData: SketchData;
  plane: string;
  height: number;
  reverse: boolean;
  symmetric: boolean;
  startOffset: number;
  planeOffset: number;
  /** When set (from sketch feature), extrude/cut uses this plane instead of axis-aligned `plane` only. */
  planeRef?: Extract<GeometricSelectionRef, { type: "defaultPlane" | "face" | "plane" }> | null;
}

/** Same sketch placement inputs as extrude/cut; revolution uses {@link revolution} with angle (degrees). */
export interface RevolveFeatureInput {
  id: string;
  name: string;
  type: "revolve" | "revolveCut";
  sketchData: SketchData;
  plane: string;
  planeOffset: number;
  startOffset: number;
  planeRef?: Extract<GeometricSelectionRef, { type: "defaultPlane" | "face" | "plane" }> | null;
  angle: number;
  axis: "x" | "y" | "z";
}

export interface EdgeBlendFeatureInput {
  id: string;
  name: string;
  type: "fillet" | "chamfer";
  targetFeatureId: string;
  value: number;
  selectedEdgeMidpoints: [number, number, number][];
  selectedEdgeBoxes: { min: [number, number, number]; max: [number, number, number] }[];
}

export type FeatureInput = SketchBooleanFeatureInput | RevolveFeatureInput | EdgeBlendFeatureInput;

function buildAccumShapes(features: FeatureInput[]): { shape: Shape3D; featureId: string; featureName: string }[] {
  let accumShapes: { shape: Shape3D; featureId: string; featureName: string }[] = [];

  const shapeBBox = (shape: Shape3D): { min: [number, number, number]; max: [number, number, number] } | null => {
    try {
      const m = shape.mesh({ tolerance: 0.2, angularTolerance: 0.2 });
      if (!m.vertices?.length) return null;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < m.vertices.length; i += 3) {
        const x = m.vertices[i], y = m.vertices[i + 1], z = m.vertices[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
    } catch {
      return null;
    }
  };

  const overlapVolume = (
    a: { min: [number, number, number]; max: [number, number, number] } | null,
    b: { min: [number, number, number]; max: [number, number, number] } | null,
  ): number => {
    if (!a || !b) return 0;
    const dx = Math.max(0, Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]));
    const dy = Math.max(0, Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]));
    const dz = Math.max(0, Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]));
    return dx * dy * dz;
  };

  const boxesTouchOrOverlap = (
    a: { min: [number, number, number]; max: [number, number, number] } | null,
    b: { min: [number, number, number]; max: [number, number, number] } | null,
    tol = 1e-4,
  ): boolean => {
    if (!a || !b) return false;
    const xOk = a.max[0] >= b.min[0] - tol && b.max[0] >= a.min[0] - tol;
    const yOk = a.max[1] >= b.min[1] - tol && b.max[1] >= a.min[1] - tol;
    const zOk = a.max[2] >= b.min[2] - tol && b.max[2] >= a.min[2] - tol;
    return xOk && yOk && zOk;
  };

  for (const feat of features) {
    if (feat.type === "fillet" || feat.type === "chamfer") {
      console.log("[CAD][BuildAccum][FeatureStart]", {
        id: feat.id,
        name: feat.name,
        type: feat.type,
        targetFeatureId: feat.targetFeatureId,
        value: feat.value,
        selectedEdgeCount: feat.selectedEdgeMidpoints.length,
      });
      const targetIdx = accumShapes.findIndex((s) => s.featureId === feat.targetFeatureId);
      if (targetIdx < 0) continue;
      try {
        if (!feat.selectedEdgeMidpoints.length) continue;
        const v = Math.max(Number(feat.value) || 0, 0.001);
        const selected = feat.selectedEdgeMidpoints;
        const selectedBoxes = feat.selectedEdgeBoxes;
        if (!selected.length) continue;
        const targetShape = accumShapes[targetIdx].shape;
        const toTuple = (v: any): [number, number, number] => {
          if (!v) return [0, 0, 0];
          if (typeof v.toTuple === "function") return v.toTuple();
          if (Array.isArray(v) && v.length >= 3) return [v[0], v[1], v[2]];
          return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
        };
        const edgeMidpoint = (edge: any): [number, number, number] => {
          const a = toTuple(edge?.startPoint);
          const b = toTuple(edge?.endPoint);
          return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
        };
        const pointInBox = (p: [number, number, number], box: { min: [number, number, number]; max: [number, number, number] }) =>
          p[0] >= box.min[0] && p[0] <= box.max[0] &&
          p[1] >= box.min[1] && p[1] <= box.max[1] &&
          p[2] >= box.min[2] && p[2] <= box.max[2];
        const dist = (a: [number, number, number], b: [number, number, number]) =>
          Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        const shapeEdges = Array.isArray((targetShape as any).edges) ? (targetShape as any).edges : [];
        const matchedEdges: any[] = [];
        for (let i = 0; i < selected.length; i++) {
          const selMid = selected[i];
          const selBox = selectedBoxes[i];
          const refBox = selBox ?? { min: selMid, max: selMid };
          const dx = Math.abs(refBox.max[0] - refBox.min[0]);
          const dy = Math.abs(refBox.max[1] - refBox.min[1]);
          const dz = Math.abs(refBox.max[2] - refBox.min[2]);
          const diag = Math.hypot(dx, dy, dz);
          const eps = Math.max(1e-4, Math.min(0.01, diag * 0.01));
          const expandedBox = {
            min: [refBox.min[0] - eps, refBox.min[1] - eps, refBox.min[2] - eps] as [number, number, number],
            max: [refBox.max[0] + eps, refBox.max[1] + eps, refBox.max[2] + eps] as [number, number, number],
          };
          let bestEdge: any = null;
          let bestScore = Infinity;
          for (const edge of shapeEdges) {
            const mid = edgeMidpoint(edge);
            if (!pointInBox(mid, expandedBox)) continue;
            const d = dist(mid, selMid);
            if (d < bestScore) {
              bestScore = d;
              bestEdge = edge;
            }
          }
          if (bestEdge) matchedEdges.push(bestEdge);
        }
        const filter = matchedEdges.length
          ? ((finder: any) => finder.inList(matchedEdges))
          : ((finder: any) => finder.either(
              selected.map((pt) => (f: any) => f.withinDistance(1e-3, pt))
            ));
        const blended = feat.type === "fillet"
          ? (targetShape.fillet(v, filter) as Shape3D)
          : (targetShape.chamfer(v, filter) as Shape3D);
        accumShapes[targetIdx] = { shape: blended, featureId: feat.id, featureName: feat.name };
      } catch (e) {
        console.warn(`CSG ${feat.type} failed:`, e);
      }
      continue;
    }
    if (feat.type === "revolve" || feat.type === "revolveCut") {
      const rop = feat as RevolveFeatureInput;
      console.log("[CAD][BuildAccum][FeatureStart]", {
        id: rop.id,
        name: rop.name,
        type: rop.type,
        plane: rop.plane,
        planeOffset: rop.planeOffset,
        angle: rop.angle,
        axis: rop.axis,
        startOffset: rop.startOffset,
      });
      const toolSolids = sketchToRevolveSolids(rop);
      console.log("[CAD][BuildAccum][ToolSolids]", {
        featureId: rop.id,
        count: toolSolids.length,
      });
      if (toolSolids.length === 0) continue;

      if (feat.type === "revolveCut") {
        for (let ti = 0; ti < toolSolids.length; ti++) {
          const tool = toolSolids[ti];
          const toolBox = shapeBBox(tool);
          accumShapes = accumShapes.map((item) => {
            try {
              const baseBox = shapeBBox(item.shape);
              if (overlapVolume(baseBox, toolBox) <= 0) return item;
              const result = item.shape.cut(tool) as Shape3D;
              return { ...item, shape: result };
            } catch (e) {
              console.warn("CSG cut failed (revolve cut):", e);
              return item;
            }
          });
        }
        continue;
      }

      for (const s of toolSolids) {
        if (!accumShapes.length) {
          accumShapes.push({ shape: s, featureId: rop.id, featureName: rop.name });
          continue;
        }
        const sBox = shapeBBox(s);
        let bestIdx = -1;
        let bestOverlap = -1;
        for (let i = 0; i < accumShapes.length; i++) {
          const baseBox = shapeBBox(accumShapes[i].shape);
          if (!boxesTouchOrOverlap(baseBox, sBox)) continue;
          const ov = overlapVolume(baseBox, sBox);
          if (ov > bestOverlap) {
            bestOverlap = ov;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) {
          try {
            const fused = accumShapes[bestIdx].shape.fuse(s) as Shape3D;
            accumShapes[bestIdx] = { shape: fused, featureId: rop.id, featureName: rop.name };
          } catch (e) {
            console.warn("CSG fuse failed (revolve), keeping separate body:", e);
            accumShapes.push({ shape: s, featureId: rop.id, featureName: rop.name });
          }
        } else {
          accumShapes.push({ shape: s, featureId: rop.id, featureName: rop.name });
        }
      }
      continue;
    }
    const op = feat as SketchBooleanFeatureInput;
    console.log("[CAD][BuildAccum][FeatureStart]", {
      id: op.id,
      name: op.name,
      type: op.type,
      plane: op.plane,
      planeOffset: op.planeOffset,
      height: op.height,
      reverse: op.reverse,
      symmetric: op.symmetric,
      startOffset: op.startOffset,
    });
    const toolSolids = sketchToSolids(op);
    console.log("[CAD][BuildAccum][ToolSolids]", {
      featureId: op.id,
      count: toolSolids.length,
    });
    if (toolSolids.length === 0) continue;

    if (op.type === "extrude") {
      for (const s of toolSolids) {
        if (!accumShapes.length) {
          accumShapes.push({ shape: s, featureId: op.id, featureName: op.name });
          continue;
        }
        const sBox = shapeBBox(s);
        let bestIdx = -1;
        let bestOverlap = -1;
        for (let i = 0; i < accumShapes.length; i++) {
          const baseBox = shapeBBox(accumShapes[i].shape);
          if (!boxesTouchOrOverlap(baseBox, sBox)) continue;
          const ov = overlapVolume(baseBox, sBox);
          console.log("[CAD][Extrude][FuseCandidate]", {
            extrudeFeatureId: op.id,
            candidateShapeIndex: i,
            overlapVolume: ov,
          });
          if (ov > bestOverlap) {
            bestOverlap = ov;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) {
          try {
            const fused = accumShapes[bestIdx].shape.fuse(s) as Shape3D;
            console.log("[CAD][Extrude][FusePicked]", {
              extrudeFeatureId: op.id,
              targetShapeIndex: bestIdx,
              overlapVolume: bestOverlap,
            });
            accumShapes[bestIdx] = { shape: fused, featureId: op.id, featureName: op.name };
          } catch (e) {
            console.warn("CSG fuse failed, keeping separate body:", e);
            accumShapes.push({ shape: s, featureId: op.id, featureName: op.name });
          }
        } else {
          console.log("[CAD][Extrude][NoFuseTarget]", {
            extrudeFeatureId: op.id,
          });
          accumShapes.push({ shape: s, featureId: op.id, featureName: op.name });
        }
      }
    } else {
      // Cut: for partial-depth pockets, direction can be wrong if face orientation
      // doesn't match sketch convention. Build opposite-direction tools too and
      // pick whichever overlaps the current base solid more.
      const altSolids = sketchToSolids({ ...op, reverse: !op.reverse });

      // Cut: subtract each tool solid from all accumulated shapes
      for (let ti = 0; ti < toolSolids.length; ti++) {
        const tool = toolSolids[ti];
        const alt = altSolids[ti];
        const toolBox = shapeBBox(tool);
        const altBox = alt ? shapeBBox(alt) : null;
        accumShapes = accumShapes.map((item) => {
          try {
            const baseBox = shapeBBox(item.shape);
            const ovMain = overlapVolume(baseBox, toolBox);
            const ovAlt = overlapVolume(baseBox, altBox);
            const pickedTool = ovAlt > ovMain && alt ? alt : tool;
            const pickedOverlap = Math.max(ovMain, ovAlt);
            if (pickedOverlap <= 0) return item;
            const result = item.shape.cut(pickedTool);
            return { ...item, shape: result as Shape3D };
          } catch (e) {
            console.warn("CSG cut failed:", e);
            return item;
          }
        });
      }
    }
  }

  return accumShapes;
}

export function buildAllSolids(features: FeatureInput[]): SolidMeshData[] {
  if (!_ready) return [];
  const accumShapes = buildAccumShapes(features);

  return accumShapes.map((item) =>
    extractMeshData(item.shape, item.featureId, item.featureName),
  );
}

function unionShapes(shapes: Shape3D[]): Shape3D | null {
  if (!shapes.length) return null;
  let out = shapes[0];
  for (let i = 1; i < shapes.length; i++) {
    try {
      out = out.fuse(shapes[i]) as Shape3D;
    } catch {
      // Keep best-effort union for preview diff visualization.
    }
  }
  return out;
}

export function buildPreviewDifferenceSolids(
  beforeFeatures: FeatureInput[],
  afterFeatures: FeatureInput[],
): SolidMeshData[] {
  if (!_ready) return [];
  const beforeAccum = buildAccumShapes(beforeFeatures);
  const afterAccum = buildAccumShapes(afterFeatures);
  const beforeUnion = unionShapes(beforeAccum.map((s) => s.shape));
  const afterUnion = unionShapes(afterAccum.map((s) => s.shape));
  if (!beforeUnion && !afterUnion) return [];

  const out: SolidMeshData[] = [];
  if (afterUnion) {
    try {
      const added = beforeUnion ? (afterUnion.cut(beforeUnion) as Shape3D) : afterUnion;
      out.push(extractMeshData(added, "__preview_diff_added__", "Preview Added"));
    } catch {
      // ignore
    }
  }
  if (beforeUnion && afterUnion) {
    try {
      const removed = beforeUnion.cut(afterUnion) as Shape3D;
      out.push(extractMeshData(removed, "__preview_diff_removed__", "Preview Removed"));
    } catch {
      // ignore
    }
  }
  return out;
}


export interface SectionSketchOverlay2D {
  triangles: { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }[];
  edgeSegments: { x1: number; y1: number; x2: number; y2: number }[];
}

/**
 * Silhouette projection of solid bodies onto the sketch plane.
 *
 * Strategy (rethought from scratch):
 *   1. Tessellate each solid with the CAD mesh.
 *   2. For every triangle compute the face normal and its dot with the sketch
 *      plane normal (= the view direction for an orthographic camera positioned
 *      above the plane).
 *   3. FILL  – project only front-facing triangles (dot > 0) onto the 2D sketch
 *      plane.  This gives the exact orthographic silhouette shadow without any
 *      boolean slab operation.
 *   4. EDGES – build per-mesh-edge adjacency and emit:
 *        • Silhouette edges   – shared by one front-face and one back-face tri.
 *        • Boundary edges     – owned by exactly one front-face tri (open mesh
 *          boundary that faces the viewer, e.g. the rim of a cut feature).
 *        • Sharp feature edges – both neighbours are front-facing but the angle
 *          between their normals exceeds SHARP_ANGLE_DEG (avoids drawing every
 *          tessellation seam on smooth curved surfaces).
 */
export function buildSectionSketchOverlay2D(
  features: FeatureInput[],
  activeSketch: SketchFeature,
): SectionSketchOverlay2D {
  const empty: SectionSketchOverlay2D = { triangles: [], edgeSegments: [] };
  if (!_ready) return empty;
  const accumShapes = buildAccumShapes(features);
  if (!accumShapes.length) return empty;

  const basis = getSketchPlaneBasis(activeSketch);
  const [nx, ny, nz] = basis.n; // sketch plane normal = orthographic view direction

  const tris2d: SectionSketchOverlay2D["triangles"] = [];
  const edgeSegments: SectionSketchOverlay2D["edgeSegments"] = [];

  // cos(θ) threshold for "sharp" feature edges between two front-facing triangles.
  // Smooth tessellation seams on cylinders/fillets stay well below this angle.
  const SHARP_EDGE_COS = Math.cos((35 * Math.PI) / 180);

  for (const item of accumShapes) {
    try {
      // Moderate tolerance – good silhouette quality without excessive triangle count.
      const m = item.shape.mesh({ tolerance: 0.04, angularTolerance: 0.4 });
      if (!m.vertices?.length || !m.triangles?.length) continue;

      const verts = m.vertices;   // flat Float32Array: [x0,y0,z0, x1,y1,z1, ...]
      const tris  = m.triangles;  // flat array: [v0,v1,v2, v0,v1,v2, ...]
      const nTris = Math.floor(tris.length / 3);

      // Compute unit face normal and dot-with-view for every triangle.
      const faceNx  = new Float64Array(nTris);
      const faceNy  = new Float64Array(nTris);
      const faceNz  = new Float64Array(nTris);
      const faceDot = new Float64Array(nTris);

      for (let i = 0; i < nTris; i++) {
        const i1 = tris[i * 3]     * 3;
        const i2 = tris[i * 3 + 1] * 3;
        const i3 = tris[i * 3 + 2] * 3;
        // Edge vectors
        const ax = verts[i2]     - verts[i1],     ay = verts[i2 + 1] - verts[i1 + 1], az = verts[i2 + 2] - verts[i1 + 2];
        const bx = verts[i3]     - verts[i1],     by = verts[i3 + 1] - verts[i1 + 1], bz = verts[i3 + 2] - verts[i1 + 2];
        // Cross product = face normal
        let fnx = ay * bz - az * by;
        let fny = az * bx - ax * bz;
        let fnz = ax * by - ay * bx;
        const len = Math.hypot(fnx, fny, fnz);
        if (len > 1e-12) { fnx /= len; fny /= len; fnz /= len; }
        faceNx[i] = fnx; faceNy[i] = fny; faceNz[i] = fnz;
        faceDot[i] = fnx * nx + fny * ny + fnz * nz;
      }

      // ── FILL: project front-facing triangles ──────────────────────────────
      for (let i = 0; i < nTris; i++) {
        if (faceDot[i] <= 0) continue;
        const i1 = tris[i * 3]     * 3;
        const i2 = tris[i * 3 + 1] * 3;
        const i3 = tris[i * 3 + 2] * 3;
        const p1 = worldToSketch2D(activeSketch, verts[i1], verts[i1 + 1], verts[i1 + 2]);
        const p2 = worldToSketch2D(activeSketch, verts[i2], verts[i2 + 1], verts[i2 + 2]);
        const p3 = worldToSketch2D(activeSketch, verts[i3], verts[i3 + 1], verts[i3 + 2]);
        const area = Math.abs((p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x));
        if (area < 1e-10) continue; // degenerate projected triangle
        tris2d.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: p3.x, y3: p3.y });
      }

      // ── EDGES: silhouette + visible feature edges ─────────────────────────
      // Build map: "minVIdx_maxVIdx" → list of triangle indices sharing that edge.
      const edgeToTris = new Map<string, number[]>();
      for (let i = 0; i < nTris; i++) {
        const v0 = tris[i * 3], v1 = tris[i * 3 + 1], v2 = tris[i * 3 + 2];
        const pairs: [number, number][] = [[v0, v1], [v1, v2], [v2, v0]];
        for (const [a, b] of pairs) {
          const key = a < b ? `${a}_${b}` : `${b}_${a}`;
          const arr = edgeToTris.get(key);
          if (arr) arr.push(i);
          else edgeToTris.set(key, [i]);
        }
      }

      for (const [key, triList] of edgeToTris) {
        const us = key.indexOf('_');
        const aVIdx = parseInt(key.slice(0, us));
        const bVIdx = parseInt(key.slice(us + 1));

        let drawEdge = false;

        if (triList.length === 1) {
          // Boundary (open mesh edge): draw when the single face is front-facing.
          drawEdge = faceDot[triList[0]] > 0;
        } else {
          const front0 = faceDot[triList[0]] > 0;
          const front1 = faceDot[triList[1]] > 0;
          if (front0 !== front1) {
            // Silhouette: one side faces viewer, other side faces away.
            drawEdge = true;
          } else if (front0) {
            // Both front-facing: draw only if the dihedral angle is sharp enough
            // to represent a real feature edge (not a smooth tessellation seam).
            const dotN =
              faceNx[triList[0]] * faceNx[triList[1]] +
              faceNy[triList[0]] * faceNy[triList[1]] +
              faceNz[triList[0]] * faceNz[triList[1]];
            drawEdge = dotN < SHARP_EDGE_COS;
          }
        }

        if (!drawEdge) continue;

        const va = aVIdx * 3, vb = bVIdx * 3;
        const p1 = worldToSketch2D(activeSketch, verts[va],     verts[va + 1], verts[va + 2]);
        const p2 = worldToSketch2D(activeSketch, verts[vb],     verts[vb + 1], verts[vb + 2]);
        if (Math.hypot(p2.x - p1.x, p2.y - p1.y) > 1e-7) {
          edgeSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
        }
      }
    } catch {
      /* skip this body – geometry error should not crash the sketch view */
    }
  }

  return { triangles: tris2d, edgeSegments };
}

/** @deprecated Prefer {@link buildSectionSketchOverlay2D} when edges are needed */
export function buildSectionTriangles2D(
  features: FeatureInput[],
  activeSketch: SketchFeature,
): { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }[] {
  return buildSectionSketchOverlay2D(features, activeSketch).triangles;
}

export function buildSectionPaths2D(
  features: FeatureInput[],
  sketchPlane: "xy" | "xz" | "yz",
  sketchOffset: number,
): string[] {
  if (!_ready) return [];
  const accumShapes = buildAccumShapes(features);
  if (!accumShapes.length) return [];

  const slabThickness = 0.05;
  const slabSize = 20000;
  const kernelOffset = kernelPlaneOffset(sketchPlane, sketchOffset);
  let slab: Shape3D;
  let projPlane: "XY" | "XZ" | "YZ";
  if (sketchPlane === "xy") {
    slab = drawRectangle(slabSize, slabSize).sketchOnPlane("XY", kernelOffset - slabThickness / 2).extrude(slabThickness) as Shape3D;
    projPlane = "XY";
  } else if (sketchPlane === "xz") {
    slab = drawRectangle(slabSize, slabSize).sketchOnPlane("XZ", kernelOffset - slabThickness / 2).extrude(slabThickness) as Shape3D;
    projPlane = "XZ";
  } else {
    slab = drawRectangle(slabSize, slabSize).sketchOnPlane("YZ", kernelOffset - slabThickness / 2).extrude(slabThickness) as Shape3D;
    projPlane = "YZ";
  }

  const allPaths: string[] = [];
  for (const item of accumShapes) {
    try {
      const slice = item.shape.intersect(slab) as Shape3D;
      const proj = drawProjection(slice, projPlane);
      const paths = proj.visible.toSVGPaths();
      if (Array.isArray(paths)) {
        for (const p of paths) {
          if (Array.isArray(p)) {
            for (const pp of p) if (typeof pp === "string" && pp.trim()) allPaths.push(pp);
          } else if (typeof p === "string" && p.trim()) {
            allPaths.push(p);
          }
        }
      }
    } catch {
      // ignore section/projection failures for individual solids
    }
  }
  return allPaths;
}
