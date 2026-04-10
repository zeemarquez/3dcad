import { useEffect, useState } from 'react';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { listPartDocuments, loadPartDocument } from '@/app/documentStore';
import { useDrawingStore, computePlacementForNewView } from '../store/useDrawingStore';
import { loadPartSolids } from '../loadPartSolids';
import { DrawingTopBar, type DrawingFileToolbarActions } from './DrawingTopBar';
import { DrawingSheet } from './DrawingSheet';
import { LinkPartDialog } from './LinkPartDialog';
import { PlaceViewDialog } from './PlaceViewDialog';

export function DrawingEditor({
  onHome,
  fileActions,
}: {
  onHome: () => void;
  fileActions: DrawingFileToolbarActions;
}) {
  const linkedPartId = useDrawingStore((s) => s.linkedPartId);
  const sheet = useDrawingStore((s) => s.sheet);
  const addView = useDrawingStore((s) => s.addView);

  const [linkOpen, setLinkOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);
  const [solids, setSolids] = useState<SolidMeshData[] | null>(null);
  const [loadingSolids, setLoadingSolids] = useState(false);

  const parts = listPartDocuments();

  const linkedPartName = linkedPartId ? loadPartDocument(linkedPartId)?.meta.name : undefined;

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
        fileActions={fileActions}
        linkedPartId={linkedPartId}
        linkedPartName={linkedPartName}
        onSetLinkedPart={() => setLinkOpen(true)}
        onPlaceView={() => setPlaceOpen(true)}
      />
      <div className="flex min-h-0 flex-1 overflow-visible">
        <main className="relative flex-1 overflow-visible">
          <DrawingSheet solids={solids} loadingSolids={loadingSolids} />
        </main>
      </div>

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
        maxViewWidthMm={sheet.widthMm - 24}
        maxViewHeightMm={sheet.heightMm - 24}
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
    </div>
  );
}
