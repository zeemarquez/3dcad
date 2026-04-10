/**
 * Planar loop detection for sketch mixed graphs (lines + arcs as polylines).
 * Uses the standard "left face" walk: at each vertex, take the unused outgoing edge
 * with the smallest positive CCW angle from the incoming travel direction.
 *
 * Incoming/outgoing directions must follow the **actual** boundary (arc tangents at
 * endpoints), not chords between vertices — otherwise arc–line junctions pick the wrong
 * branch when degree ≥ 3 and loops never close.
 */

export type SketchPt = { x: number; y: number };

/** Constraints that identify sketch points that must share one graph vertex for loop finding. */
export type SketchConstraintLike = { type: string; entityIds: string[] };

/**
 * Merge points for closed-region graph walks:
 * - `coincident` constraints (two point ids are one vertex)
 * - pairs of points closer than `geomMergeEps` (fixes duplicate geometry without a constraint row)
 */
export function mergeCoincidentSketchVertices(
  points: { id: string; x: number; y: number }[],
  constraints: SketchConstraintLike[],
  geomMergeEps = 1e-6
): {
  canonical: (id: string) => string;
  mergedPtMap: Map<string, SketchPt>;
} {
  const idSet = new Set<string>();
  for (const p of points) idSet.add(p.id);
  for (const c of constraints) {
    if (c.type !== "coincident") continue;
    for (const id of c.entityIds) {
      if (typeof id === "string") idSet.add(id);
    }
  }

  const parent = new Map<string, string>();
  for (const id of idSet) parent.set(id, id);

  const find = (x: string): string => {
    let p = parent.get(x);
    if (p === undefined) {
      parent.set(x, x);
      return x;
    }
    if (p !== x) {
      const r = find(p);
      parent.set(x, r);
      return r;
    }
    return p;
  };

  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const c of constraints) {
    if (c.type !== "coincident") continue;
    const a = c.entityIds[0];
    const b = c.entityIds[1];
    if (typeof a === "string" && typeof b === "string") union(a, b);
  }

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      if (dx * dx + dy * dy < geomMergeEps * geomMergeEps) union(points[i].id, points[j].id);
    }
  }

  const groupMembers = new Map<string, Set<string>>();
  for (const id of idSet) {
    const r = find(id);
    if (!groupMembers.has(r)) groupMembers.set(r, new Set());
    groupMembers.get(r)!.add(id);
  }

  const canonicalOf = new Map<string, string>();
  for (const ids of groupMembers.values()) {
    const sorted = [...ids].sort();
    const canon = sorted[0]!;
    for (const id of ids) canonicalOf.set(id, canon);
  }

  const canonical = (id: string): string => canonicalOf.get(id) ?? id;

  const mergedPtMap = new Map<string, SketchPt>();
  for (const ids of groupMembers.values()) {
    const sorted = [...ids].sort();
    const canon = sorted[0]!;
    for (const p of points) {
      if (ids.has(p.id)) {
        mergedPtMap.set(canon, { x: p.x, y: p.y });
        break;
      }
    }
  }

  return { canonical, mergedPtMap };
}

export type LoopGraphEdge = {
  id: string;
  a: string;
  b: string;
  path: SketchPt[];
};

const LEN2_EPS = 1e-20;

/** Direction of travel into `curNode` along `e` after walking `prevNode` → `curNode`. */
export function incomingTravelTangent(
  e: { a: string; b: string; path: SketchPt[] },
  prevNode: string,
  curNode: string
): { x: number; y: number } | null {
  const p = e.path;
  if (p.length < 2) return null;
  if (e.a === prevNode && e.b === curNode) {
    return { x: p[p.length - 1].x - p[p.length - 2].x, y: p[p.length - 1].y - p[p.length - 2].y };
  }
  if (e.a === curNode && e.b === prevNode) {
    return { x: p[0].x - p[1].x, y: p[0].y - p[1].y };
  }
  return null;
}

/** Direction of travel leaving `curNode` toward `otherNode` along `e`. */
export function outgoingTravelTangent(
  e: { a: string; b: string; path: SketchPt[] },
  curNode: string,
  otherNode: string
): { x: number; y: number } | null {
  const p = e.path;
  if (p.length < 2) return null;
  if (e.a === curNode && e.b === otherNode) {
    return { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
  }
  if (e.a === otherNode && e.b === curNode) {
    return { x: p[p.length - 2].x - p[p.length - 1].x, y: p[p.length - 2].y - p[p.length - 1].y };
  }
  return null;
}

export function pickNextEdgeInFace(
  curNode: string,
  prevNode: string,
  incomingEdgeId: string,
  nbrs: { edgeId: string; other: string }[],
  ptMap: Map<string, SketchPt>,
  edgeById: Map<string, { a: string; b: string; path: SketchPt[] }>
): { edgeId: string; other: string } | null {
  if (nbrs.length === 0) return null;
  if (nbrs.length === 1) return nbrs[0];

  const cur = ptMap.get(curNode);
  const prev = ptMap.get(prevNode);
  if (!cur || !prev) return nbrs[0];

  const incE = edgeById.get(incomingEdgeId);
  let inTravel: number;
  if (incE) {
    const t = incomingTravelTangent(incE, prevNode, curNode);
    const len2 = t ? t.x * t.x + t.y * t.y : 0;
    if (t && len2 > LEN2_EPS) {
      inTravel = Math.atan2(t.y, t.x);
    } else {
      inTravel = Math.atan2(cur.y - prev.y, cur.x - prev.x);
    }
  } else {
    inTravel = Math.atan2(cur.y - prev.y, cur.x - prev.x);
  }

  let best = nbrs[0];
  let bestDelta = Infinity;
  for (const n of nbrs) {
    const seg = edgeById.get(n.edgeId);
    const o = ptMap.get(n.other);
    if (!o) continue;

    let outAng: number;
    if (seg) {
      const t = outgoingTravelTangent(seg, curNode, n.other);
      const len2 = t ? t.x * t.x + t.y * t.y : 0;
      if (t && len2 > LEN2_EPS) {
        outAng = Math.atan2(t.y, t.x);
      } else {
        outAng = Math.atan2(o.y - cur.y, o.x - cur.x);
      }
    } else {
      outAng = Math.atan2(o.y - cur.y, o.x - cur.x);
    }

    let d = outAng - inTravel;
    while (d <= 1e-12) d += 2 * Math.PI;
    while (d > 2 * Math.PI) d -= 2 * Math.PI;
    if (d < bestDelta) {
      bestDelta = d;
      best = n;
    }
  }
  return best;
}

/** Drop duplicate closing vertex when first ≈ last (stable shoelace / SVG fill). */
export function snapClosedPolyline(pts: SketchPt[], eps = 1e-5): SketchPt[] {
  if (pts.length < 3) return pts;
  const f = pts[0];
  const l = pts[pts.length - 1];
  if (Math.hypot(f.x - l.x, f.y - l.y) < eps) return pts.slice(0, -1);
  return pts;
}
