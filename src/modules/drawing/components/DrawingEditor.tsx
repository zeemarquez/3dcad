import { useCallback, useEffect, useRef, useState } from 'react';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { listPartDocuments, loadPartDocument } from '@/app/documentStore';
import { useDrawingStore, computePlacementForNewView } from '../store/useDrawingStore';
import { loadPartSolids } from '../loadPartSolids';
import { DrawingTopBar } from './DrawingTopBar';
import { DrawingDownloadFormatDialog, type DrawingExportFormat } from './DrawingDownloadFormatDialog';
import { DrawingSheet, DRAWING_SHEET_MARGIN_MM } from './DrawingSheet';
import { DrawingViewPropertiesSidebar } from './DrawingViewPropertiesSidebar';
import { DrawingTitleBlockFieldSidebar } from './DrawingTitleBlockFieldSidebar';
import { LinkPartDialog } from './LinkPartDialog';
import { PlaceViewDialog } from './PlaceViewDialog';
import { TitleBlockDialog } from './TitleBlockDialog';
import { exportDrawingSheetToPdf } from '../export/exportDrawingSheetToPdf';

export function DrawingEditor({
  onHome,
  fileActions,
  documentBaseName,
}: {
  onHome: () => void;
  /** Sanitized base name for downloaded files (no extension). */
  documentBaseName: string;
  fileActions: {
    onRenameDocument: () => void;
    onSaveAs: () => void;
    onExportDrawing: (format: DrawingExportFormat) => void;
    onCreateCopy: () => void;
  };
}) {
  const linkedPartId = useDrawingStore((s) => s.linkedPartId);
  const views = useDrawingStore((s) => s.views);
  const sheet = useDrawingStore((s) => s.sheet);
  const addView = useDrawingStore((s) => s.addView);

  const [linkOpen, setLinkOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);
  const [placeIsoOpen, setPlaceIsoOpen] = useState(false);
  const [titleBlockOpen, setTitleBlockOpen] = useState(false);
  const [downloadFormatOpen, setDownloadFormatOpen] = useState(false);
  const [solids, setSolids] = useState<SolidMeshData[] | null>(null);
  const [loadingSolids, setLoadingSolids] = useState(false);
  const sheetExportRef = useRef<HTMLDivElement>(null);

  const parts = listPartDocuments();

  const handleExportDrawing = useCallback(
    async (format: DrawingExportFormat) => {
      if (format === 'pdf') {
        const el = sheetExportRef.current;
        if (!el) return;
        try {
          await exportDrawingSheetToPdf(el, documentBaseName, {
            widthMm: sheet.widthMm,
            heightMm: sheet.heightMm,
          });
        } catch (e) {
          console.error(e);
          window.alert('Could not create PDF. Try again after the drawing has finished loading.');
        }
        return;
      }
      fileActions.onExportDrawing(format);
    },
    [documentBaseName, fileActions, sheet.heightMm, sheet.widthMm],
  );

  const linkedPartName = linkedPartId ? loadPartDocument(linkedPartId)?.meta.name : undefined;

  useEffect(() => {
    if (linkedPartId || views.length > 0) return;
    setLinkOpen(true);
  }, [linkedPartId, views.length]);

  useEffect(() => {
    if (!linkedPartId) {
      setSolids(null);
      return;
    }
    let cancelled = false;
    setLoadingSolids(true);
    loadPartSolids(linkedPartId)
      .then((s) => {
        if (!cancelled) setSolids(s);
      })
      .catch(() => {
        if (!cancelled) setSolids([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSolids(false);
      });
    return () => {
      cancelled = true;
    };
  }, [linkedPartId]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-100 text-zinc-900 font-sans">
      <DrawingTopBar
        onHomeClick={onHome}
        fileActions={{
          onRenameDocument: fileActions.onRenameDocument,
          onSaveAs: fileActions.onSaveAs,
          onDownload: () => setDownloadFormatOpen(true),
          onCreateCopy: fileActions.onCreateCopy,
        }}
        linkedPartId={linkedPartId}
        linkedPartName={linkedPartName}
        onPlaceView={() => setPlaceOpen(true)}
        onPlaceIsoView={() => setPlaceIsoOpen(true)}
        onTitleBlock={() => setTitleBlockOpen(true)}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <DrawingSheet ref={sheetExportRef} solids={solids} loadingSolids={loadingSolids} />
        </main>
        <DrawingViewPropertiesSidebar />
        <DrawingTitleBlockFieldSidebar />
      </div>

      <TitleBlockDialog open={titleBlockOpen} onClose={() => setTitleBlockOpen(false)} />

      <DrawingDownloadFormatDialog
        open={downloadFormatOpen}
        onClose={() => setDownloadFormatOpen(false)}
        onConfirm={(format) => {
          setDownloadFormatOpen(false);
          void handleExportDrawing(format);
        }}
      />

      <LinkPartDialog
        open={linkOpen}
        parts={parts}
        currentPartId={linkedPartId}
        onClose={() => setLinkOpen(false)}
        onSelect={(id) => useDrawingStore.getState().setLinkedPartId(id)}
      />

      <PlaceViewDialog
        open={placeOpen}
        partId={linkedPartId}
        maxViewWidthMm={sheet.widthMm - 2 * DRAWING_SHEET_MARGIN_MM}
        maxViewHeightMm={sheet.heightMm - 2 * DRAWING_SHEET_MARGIN_MM}
        onClose={() => setPlaceOpen(false)}
        onConfirm={(payload) => {
          const { views } = useDrawingStore.getState();
          const { sheetX, sheetY, alignment } = computePlacementForNewView(views);
          const {
            orientation,
            widthMm,
            heightMm,
            viewPlaneExtentXMm,
            viewPlaneExtentYMm,
            viewScaleNum,
            viewScaleDen,
          } = payload;
          addView({
            orientation,
            sheetX,
            sheetY,
            widthMm,
            heightMm,
            viewPlaneExtentXMm,
            viewPlaneExtentYMm,
            viewScaleNum,
            viewScaleDen,
            alignment,
          });
        }}
      />

      <PlaceViewDialog
        variant="isometric"
        open={placeIsoOpen}
        partId={linkedPartId}
        maxViewWidthMm={sheet.widthMm - 2 * DRAWING_SHEET_MARGIN_MM}
        maxViewHeightMm={sheet.heightMm - 2 * DRAWING_SHEET_MARGIN_MM}
        onClose={() => setPlaceIsoOpen(false)}
        onConfirm={(payload) => {
          const { views } = useDrawingStore.getState();
          const { sheetX, sheetY } = computePlacementForNewView(views);
          const {
            orientation,
            widthMm,
            heightMm,
            viewPlaneExtentXMm,
            viewPlaneExtentYMm,
            viewScaleNum,
            viewScaleDen,
          } = payload;
          addView({
            orientation,
            sheetX,
            sheetY,
            widthMm,
            heightMm,
            viewPlaneExtentXMm,
            viewPlaneExtentYMm,
            viewScaleNum,
            viewScaleDen,
            alignment: 'free',
          });
        }}
      />
    </div>
  );
}
