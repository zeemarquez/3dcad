import { create } from 'zustand';

/** A4 landscape (mm) — long edge horizontal */
export const A4_WIDTH_MM = 297;
export const A4_HEIGHT_MM = 210;

export interface DrawingDocumentMeta {
  id: string;
  name: string;
  extension: '.drw';
  createdAt: number;
  updatedAt: number;
}

/** First view: free 2D drag. Others: lock one axis to the primary view for projection alignment. */
export type DrawingViewAlignment = 'free' | 'vertical' | 'horizontal';

/** Primary = index 0. Odd index: same sheetX as primary (drag along Y). Even index ≥2: same sheetY (drag along X). */
export function inferViewAlignment(index: number): DrawingViewAlignment {
  if (index <= 0) return 'free';
  return index % 2 === 1 ? 'vertical' : 'horizontal';
}

/** Initial sheet position for the next view (auto-align to primary when one exists). */
export function computePlacementForNewView(existingViews: DrawingViewPlacement[]): {
  sheetX: number;
  sheetY: number;
  alignment: DrawingViewAlignment;
} {
  const idx = existingViews.length;
  const first = existingViews[0];
  if (idx === 0) {
    return { sheetX: A4_WIDTH_MM / 2, sheetY: A4_HEIGHT_MM / 2, alignment: 'free' };
  }
  if (!first) {
    return { sheetX: A4_WIDTH_MM / 2, sheetY: A4_HEIGHT_MM / 2, alignment: inferViewAlignment(idx) };
  }
  const alignment = inferViewAlignment(idx);
  if (alignment === 'vertical') {
    return {
      sheetX: first.sheetX,
      sheetY: first.sheetY + 88 * Math.ceil(idx / 2),
      alignment,
    };
  }
  return {
    sheetX: first.sheetX + 102 * (idx / 2),
    sheetY: first.sheetY,
    alignment,
  };
}

/** Quaternion x, y, z, w — rotates the part from world into view orientation (camera looks from +Z). */
export interface DrawingViewPlacement {
  id: string;
  orientation: [number, number, number, number];
  /** Sheet position (mm), origin bottom-left of inner border — center of the view box */
  sheetX: number;
  sheetY: number;
  /** Horizontal extent of the projected view on paper (mm) */
  widthMm: number;
  /** Vertical extent on paper (mm). Older saves omit; inferred as width × 0.75. */
  heightMm?: number;
  /** Model bbox size in the view XY plane (mm) — drives orthographic frustum to match paper scale. */
  viewPlaneExtentXMm?: number;
  viewPlaneExtentYMm?: number;
  /** Drawing scale as integer ratio drawing : model (e.g. 1 : 2 → paper = model × 1/2). */
  viewScaleNum?: number;
  viewScaleDen?: number;
  /** @deprecated Use viewScaleNum / viewScaleDen; kept for migration from older saves. */
  viewScale?: number;
  /** Omitted in older saves; inferred from index via {@link inferViewAlignment}. */
  alignment?: DrawingViewAlignment;
}

/** Linear dimension on a drawing view (world space after view transform, mm). */
export interface DrawingSheetDimension {
  id: string;
  viewId: string;
  kind: 'horizontal' | 'vertical';
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** Offset from the feature to the dimension line (mm), perpendicular to measurement. */
  offsetMm: number;
  /** Slide along the dimension line from center (mm), parallel to measurement. */
  alongMm: number;
}

export type DrawingDimensionMode = null | 'horizontal' | 'vertical';

export interface DrawingDocumentData {
  kind: 'drawing';
  version: 1;
  meta: DrawingDocumentMeta;
  linkedPartId: string | null;
  views: DrawingViewPlacement[];
  sheet: { widthMm: number; heightMm: number };
  /** Optional; omitted in older files. */
  dimensions?: DrawingSheetDimension[];
}

interface DrawingState {
  linkedPartId: string | null;
  views: DrawingViewPlacement[];
  selectedViewId: string | null;
  sheet: { widthMm: number; heightMm: number };
  showSheetGrid: boolean;
  toggleSheetGrid: () => void;
  sheetZoom: number;
  setSheetZoom: (z: number) => void;
  /** Pixel offset from viewport center (pans the sheet). */
  sheetPan: { x: number; y: number };
  setSheetPan: (p: { x: number; y: number }) => void;
  /** Last scale (drawing : model) used in Place standard view — restored when reopening the dialog. */
  placeViewDialogScaleNum: number;
  placeViewDialogScaleDen: number;
  setPlaceViewDialogScale: (num: number, den: number) => void;
  /** Active dimension tool (horizontal / vertical linear); null when not placing dimensions. */
  drawingDimensionMode: DrawingDimensionMode;
  setDrawingDimensionMode: (mode: DrawingDimensionMode) => void;
  dimensions: DrawingSheetDimension[];
  /** Linear dimension selection / hover (ids are unique across views). */
  selectedDimensionId: string | null;
  hoveredDimensionId: string | null;
  setSelectedDimensionId: (id: string | null) => void;
  setHoveredDimensionId: (id: string | null) => void;
  addDimension: (d: Omit<DrawingSheetDimension, 'id'> & { id?: string }) => void;
  updateDimensionOffset: (id: string, offsetMm: number) => void;
  updateDimensionGeometry: (id: string, patch: { offsetMm?: number; alongMm?: number }) => void;
  removeDimension: (id: string) => void;
  removeDimensionsForView: (viewId: string) => void;
  setLinkedPartId: (id: string | null) => void;
  addView: (v: Omit<DrawingViewPlacement, 'id'> & { id?: string }) => void;
  updateView: (
    id: string,
    patch: Partial<
      Pick<
        DrawingViewPlacement,
        | 'sheetX'
        | 'sheetY'
        | 'widthMm'
        | 'heightMm'
        | 'viewPlaneExtentXMm'
        | 'viewPlaneExtentYMm'
        | 'viewScale'
        | 'viewScaleNum'
        | 'viewScaleDen'
        | 'orientation'
        | 'alignment'
      >
    >,
  ) => void;
  /** Move the primary view (index 0) and sync aligned secondary views in one update. */
  movePrimaryOnSheet: (sheetX: number, sheetY: number) => void;
  removeView: (id: string) => void;
  setSelectedViewId: (id: string | null) => void;
  exportDrawingDocumentData: (meta: DrawingDocumentMeta) => DrawingDocumentData;
  importDrawingDocumentData: (doc: DrawingDocumentData) => void;
  resetDrawing: () => void;
}

const defaultSheet = () => ({ widthMm: A4_WIDTH_MM, heightMm: A4_HEIGHT_MM });

/** Migrate older portrait A4 stored in saved .drw files. */
function normalizeSheetLayout(s: { widthMm: number; heightMm: number }): { widthMm: number; heightMm: number } {
  if (s.widthMm < s.heightMm) {
    return { widthMm: s.heightMm, heightMm: s.widthMm };
  }
  return { ...s };
}

const LEGACY_VIEW_HEIGHT_RATIO = 0.75;

function migrateViewPlacement(w: DrawingViewPlacement, index: number): DrawingViewPlacement {
  const num = w.viewScaleNum ?? 1;
  const den = w.viewScaleDen ?? w.viewScale ?? 1;
  let heightMm = w.heightMm;
  let extX = w.viewPlaneExtentXMm;
  let extY = w.viewPlaneExtentYMm;

  if (heightMm == null) {
    heightMm = w.widthMm * LEGACY_VIEW_HEIGHT_RATIO;
  }
  if (extX == null || extY == null) {
    extX = (w.widthMm * den) / Math.max(1, num);
    extY = ((heightMm ?? w.widthMm * LEGACY_VIEW_HEIGHT_RATIO) * den) / Math.max(1, num);
  }

  return {
    ...w,
    alignment: w.alignment ?? inferViewAlignment(index),
    viewScaleNum: num,
    viewScaleDen: den,
    heightMm,
    viewPlaneExtentXMm: extX,
    viewPlaneExtentYMm: extY,
  };
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
  linkedPartId: null,
  views: [],
  selectedViewId: null,
  sheet: defaultSheet(),
  showSheetGrid: true,
  sheetZoom: 1,
  sheetPan: { x: 0, y: 0 },
  placeViewDialogScaleNum: 1,
  placeViewDialogScaleDen: 1,
  drawingDimensionMode: null,
  dimensions: [],
  selectedDimensionId: null,
  hoveredDimensionId: null,

  setDrawingDimensionMode: (mode) => set({ drawingDimensionMode: mode }),
  setSelectedDimensionId: (id) => set({ selectedDimensionId: id }),
  setHoveredDimensionId: (id) => set({ hoveredDimensionId: id }),

  addDimension: (d) => {
    const id = d.id ?? crypto.randomUUID();
    const alongMm = d.alongMm ?? 0;
    set((s) => ({
      dimensions: [...s.dimensions, { ...d, id, alongMm }],
    }));
  },

  updateDimensionOffset: (id, offsetMm) =>
    set((s) => ({
      dimensions: s.dimensions.map((dim) => (dim.id === id ? { ...dim, offsetMm } : dim)),
    })),

  updateDimensionGeometry: (id, patch) =>
    set((s) => ({
      dimensions: s.dimensions.map((dim) => {
        if (dim.id !== id) return dim;
        return {
          ...dim,
          ...(patch.offsetMm !== undefined ? { offsetMm: patch.offsetMm } : {}),
          ...(patch.alongMm !== undefined ? { alongMm: patch.alongMm } : {}),
        };
      }),
    })),

  removeDimension: (id) =>
    set((s) => ({
      dimensions: s.dimensions.filter((d) => d.id !== id),
      selectedDimensionId: s.selectedDimensionId === id ? null : s.selectedDimensionId,
      hoveredDimensionId: s.hoveredDimensionId === id ? null : s.hoveredDimensionId,
    })),

  removeDimensionsForView: (viewId) =>
    set((s) => ({
      dimensions: s.dimensions.filter((d) => d.viewId !== viewId),
    })),

  toggleSheetGrid: () => set((s) => ({ showSheetGrid: !s.showSheetGrid })),
  setSheetZoom: (z) => set({ sheetZoom: Math.min(4, Math.max(0.25, z)) }),
  setSheetPan: (p) => set({ sheetPan: p }),

  setPlaceViewDialogScale: (num, den) =>
    set({
      placeViewDialogScaleNum: Math.max(1, Math.round(num)),
      placeViewDialogScaleDen: Math.max(1, Math.round(den)),
    }),

  setLinkedPartId: (id) => set({ linkedPartId: id }),

  addView: (v) => {
    const id = v.id ?? crypto.randomUUID();
    const { views } = get();
    const idx = views.length;
    const alignment = v.alignment ?? inferViewAlignment(idx);
    const num = v.viewScaleNum ?? 1;
    const den = v.viewScaleDen ?? v.viewScale ?? 1;
    const heightMm = v.heightMm ?? v.widthMm * LEGACY_VIEW_HEIGHT_RATIO;
    const viewPlaneExtentXMm = v.viewPlaneExtentXMm ?? (v.widthMm * den) / num;
    const viewPlaneExtentYMm = v.viewPlaneExtentYMm ?? (heightMm * den) / num;
    set((s) => ({
      views: [
        ...s.views,
        {
          id,
          orientation: v.orientation,
          sheetX: v.sheetX,
          sheetY: v.sheetY,
          widthMm: v.widthMm,
          heightMm,
          viewPlaneExtentXMm,
          viewPlaneExtentYMm,
          viewScaleNum: num,
          viewScaleDen: den,
          alignment,
        },
      ],
      selectedViewId: id,
    }));
  },

  updateView: (id, patch) =>
    set((s) => ({
      views: s.views.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    })),

  movePrimaryOnSheet: (sheetX, sheetY) =>
    set((s) => {
      if (!s.views.length) return s;
      return {
        views: s.views.map((w, i) => {
          if (i === 0) return { ...w, sheetX, sheetY };
          const al = w.alignment ?? inferViewAlignment(i);
          if (al === 'vertical') return { ...w, sheetX };
          if (al === 'horizontal') return { ...w, sheetY };
          return w;
        }),
      };
    }),

  removeView: (id) =>
    set((s) => ({
      views: s.views.filter((w) => w.id !== id),
      selectedViewId: s.selectedViewId === id ? null : s.selectedViewId,
      dimensions: s.dimensions.filter((d) => d.viewId !== id),
      selectedDimensionId: s.dimensions.some((d) => d.viewId === id && d.id === s.selectedDimensionId)
        ? null
        : s.selectedDimensionId,
      hoveredDimensionId: s.dimensions.some((d) => d.viewId === id && d.id === s.hoveredDimensionId)
        ? null
        : s.hoveredDimensionId,
    })),

  setSelectedViewId: (id) => set({ selectedViewId: id }),

  exportDrawingDocumentData: (meta) => {
    const s = get();
    return {
      kind: 'drawing',
      version: 1,
      meta,
      linkedPartId: s.linkedPartId,
      views: JSON.parse(JSON.stringify(s.views)) as DrawingViewPlacement[],
      sheet: { ...s.sheet },
      dimensions: JSON.parse(JSON.stringify(s.dimensions)) as DrawingSheetDimension[],
    };
  },

  importDrawingDocumentData: (doc) => {
    const raw = JSON.parse(JSON.stringify(doc.views ?? [])) as DrawingViewPlacement[];
    const views = raw.map((w, i) => migrateViewPlacement(w, i));
    const dimsRaw = doc.dimensions;
    const dimensions =
      Array.isArray(dimsRaw) && dimsRaw.length > 0
        ? (JSON.parse(JSON.stringify(dimsRaw)) as Array<DrawingSheetDimension & { az?: number; bz?: number; alongMm?: number }>).map(
            (d) => ({
              ...d,
              az: d.az ?? 0,
              bz: d.bz ?? 0,
              alongMm: d.alongMm ?? 0,
            }),
          )
        : [];
    set({
      linkedPartId: doc.linkedPartId ?? null,
      views,
      selectedViewId: null,
      sheet: normalizeSheetLayout(doc.sheet ?? defaultSheet()),
      sheetPan: { x: 0, y: 0 },
      sheetZoom: 1,
      dimensions,
      drawingDimensionMode: null,
      selectedDimensionId: null,
      hoveredDimensionId: null,
    });
  },

  resetDrawing: () =>
    set({
      linkedPartId: null,
      views: [],
      selectedViewId: null,
      sheet: defaultSheet(),
      showSheetGrid: true,
      sheetZoom: 1,
      sheetPan: { x: 0, y: 0 },
      dimensions: [],
      drawingDimensionMode: null,
      selectedDimensionId: null,
      hoveredDimensionId: null,
    }),
}));
