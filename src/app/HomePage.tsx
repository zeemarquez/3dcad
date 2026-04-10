import { useEffect, useState } from 'react';
import type { RecentDocumentEntry } from './documentStore';
import { loadPartDocument } from './documentStore';
import { initCAD, buildAllSolids, type SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { featuresToCadFeatureInputs } from '@/modules/part/kernel/cadFeatureInputs';
import { PartThumbnailCanvas } from '@/modules/part/components/PartThumbnailCanvas';

interface HomePageProps {
  recents: RecentDocumentEntry[];
  onCreatePart: () => void;
  onOpenDocument: (id: string) => void;
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

export const HomePage = ({ recents, onCreatePart, onOpenDocument }: HomePageProps) => {
  return (
    <div className="h-screen w-screen bg-zinc-100 text-zinc-900 overflow-auto">
      <div className="max-w-6xl mx-auto px-8 py-10">
        <h1 className="text-2xl font-semibold mb-2">ModernCAD</h1>

        <div className="bg-white border border-zinc-300 rounded-lg p-5 mb-6">
          <button
            type="button"
            onClick={onCreatePart}
            className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors"
          >
            New Part Document
          </button>
        </div>

        <div className="bg-white border border-zinc-300 rounded-lg p-5">
          <h2 className="text-base font-semibold mb-4">Recent parts</h2>
          {recents.length === 0 ? (
            <p className="text-sm text-zinc-500">No recent documents yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recents.map((doc) => (
                <PartDocumentCard key={doc.id} doc={doc} onOpen={() => onOpenDocument(doc.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
