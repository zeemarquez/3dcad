/** Viewport mesh / overlay colors */
export const C_BASE = '#bfdbfe';
export const C_FACE_HOV = '#93c5fd';
export const C_SEL = '#f59e0b';
export const C_EDGE = '#334155';
export const C_EDGE_HOV = '#38bdf8';

/** 3D sketch overlay: filled regions + wire */
export const C_SKETCH_VIEW_FILL = '#2563eb';
export const C_SKETCH_VIEW_FILL_OP = 0.25;
export const C_SKETCH_VIEW_FILL_SEL_OP = 0.5;
export const C_SKETCH_VIEW_LINE = '#1e40af';

/** Max midpoint distance (model units) between stored ref and mesh edge — allows tessellation drift */
export const EDGE_PREFETCH_MID_MAX = 0.04;
/** Direction vectors must be parallel (same line), |dot| ≥ this */
export const EDGE_PREFETCH_DIR_DOT_MIN = 0.98;

export const VERTEX_MATCH_TOL_SQ = 0.04 * 0.04;
