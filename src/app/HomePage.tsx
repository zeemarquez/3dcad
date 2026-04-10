import { useEffect, useState } from 'react';
import type { RecentDocumentEntry } from './documentStore';
import { loadPartDocument } from './documentStore';
import { initCAD, buildAllSolids, type SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { featuresToCadFeatureInputs } from '@/modules/part/kernel/cadFeatureInputs';
import { PartThumbnailCanvas } from '@/modules/part/components/PartThumbnailCanvas';
import { FileImage } from 'lucide-react';

interface HomePageProps {
  recents: RecentDocumentEntry[];
  onCreatePart: () => void;
  onCreateDrawing: () => void;
  onOpenDocument: (id: string, type: 'part' | 'drawing') => void;
}

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function PartDocumentCard({
  doc,
  onOpen,
}: {
  doc: RecentDocumentEntry;
  onOpen: () => void;
}) {
  const [solids, setSolids] = useState<SolidMeshData[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setSolids(null);
      try {
        await initCAD();
        if (cancelled) return;
        const data = loadPartDocument(doc.id);
        if (!data) {
          setSolids([]);
          return;
        }
        const inputs = featuresToCadFeatureInputs(data.operations);
        const built = buildAllSolids(inputs);
        if (!cancelled) setSolids(built);
      } catch {
        if (!cancelled) setSolids([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col text-left rounded-lg border border-zinc-200 bg-white shadow-sm hover:border-zinc-300 hover:shadow-md transition-all overflow-hidden"
    >
      <PartThumbnailCanvas
        solids={solids}
        loading={loading}
        emptyLabel="No solid geometry yet"
        className="rounded-t-lg"
      />
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="text-sm font-medium text-zinc-900 group-hover:text-blue-700 transition-colors">
          {doc.name}
          {doc.extension}
        </div>
        <div className="text-xs text-zinc-500">Part document</div>
        <div className="text-xs text-zinc-400 mt-auto">{formatTimestamp(doc.updatedAt)}</div>
      </div>
    </button>
  );
}

function DrawingDocumentCard({
  doc,
  onOpen,
}: {
  doc: RecentDocumentEntry;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col text-left rounded-lg border border-zinc-200 bg-white shadow-sm hover:border-zinc-300 hover:shadow-md transition-all overflow-hidden"
    >
      <div className="relative w-full overflow-hidden rounded-t-lg bg-gradient-to-br from-zinc-100 to-zinc-200 aspect-[4/3] flex flex-col items-center justify-center gap-2">
        <FileImage className="w-12 h-12 text-zinc-400" aria-hidden />
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">A4 drawing</span>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="text-sm font-medium text-zinc-900 group-hover:text-blue-700 transition-colors">
          {doc.name}
          {doc.extension}
        </div>
        <div className="text-xs text-zinc-500">Drawing document</div>
        <div className="text-xs text-zinc-400 mt-auto">{formatTimestamp(doc.updatedAt)}</div>
      </div>
    </button>
  );
}

export const HomePage = ({
  recents,
  onCreatePart,
  onCreateDrawing,
  onOpenDocument,
}: HomePageProps) => {
  return (
    <div className="h-screen w-screen bg-zinc-100 text-zinc-900 overflow-auto">
      <div className="max-w-6xl mx-auto px-8 py-10">
        <h1 className="text-2xl font-semibold mb-2">ModernCAD</h1>

        <div className="bg-white border border-zinc-300 rounded-lg p-5 mb-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onCreatePart}
            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors"
          >
            New Part Document
          </button>
          <button
            type="button"
            onClick={onCreateDrawing}
            className="px-4 py-2 rounded-md border border-zinc-300 bg-white text-sm font-medium text-zinc-800 hover:bg-zinc-50 transition-colors"
          >
            New Drawing
          </button>
        </div>

        <div className="bg-white border border-zinc-300 rounded-lg p-5">
          <h2 className="text-base font-semibold mb-4">Recent documents</h2>
          {recents.length === 0 ? (
            <p className="text-sm text-zinc-500">No recent documents yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recents.map((doc) =>
                doc.type === 'drawing' ? (
                  <DrawingDocumentCard
                    key={doc.id}
                    doc={doc}
                    onOpen={() => onOpenDocument(doc.id, 'drawing')}
                  />
                ) : (
                  <PartDocumentCard key={doc.id} doc={doc} onOpen={() => onOpenDocument(doc.id, 'part')} />
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
