export { DrawingEditor } from './components/DrawingEditor';
export {
  useDrawingStore,
  A4_WIDTH_MM,
  A4_HEIGHT_MM,
  inferViewAlignment,
  computePlacementForNewView,
} from './store/useDrawingStore';
export { computePaperViewLayout, computePaperViewWidthMm } from './computePaperViewWidth';
export type { PaperViewLayoutResult } from './computePaperViewWidth';
export type {
  DrawingDocumentData,
  DrawingDocumentMeta,
  DrawingViewPlacement,
  DrawingViewAlignment,
  DrawingSheetDimension,
  DrawingDimensionMode,
} from './store/useDrawingStore';
