import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { RecentDocumentEntry } from '@/app/documentStore';
import { loadPartDocument } from '@/app/documentStore';
import { initCAD, buildAllSolids, type SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { featuresToCadFeatureInputs } from '@/modules/part/kernel/cadFeatureInputs';
import { PartThumbnailCanvas } from '@/modules/part/components/PartThumbnailCanvas';

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function PartLinkCard({
  doc,
  active,
  onPick,
}: {
  doc: RecentDocumentEntry;
  active: boolean;
  onPick: () => void;
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
      onClick={onPick}
      className={`group flex flex-col text-left rounded-lg border bg-white shadow-sm transition-all overflow-hidden ${
        active
          ? 'ring-2 ring-blue-500 border-blue-400'
          : 'border-zinc-200 hover:border-zinc-300 hover:shadow-md'
      }`}
    >
      <PartThumbnailCanvas
        solids={solids}
        loading={loading}
        emptyLabel="No solid geometry yet"
        className="rounded-t-lg"
      />
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div
          className={`text-sm font-medium transition-colors ${
            active ? 'text-blue-800' : 'text-zinc-900 group-hover:text-blue-700'
          }`}
        >
          {doc.name}
          {doc.extension}
        </div>
        <div className="text-xs text-zinc-500">Part document</div>
        <div className="text-xs text-zinc-400 mt-auto">{formatTimestamp(doc.updatedAt)}</div>
      </div>
    </button>
  );
}

export function LinkPartDialog({
  open,
  parts,
  currentPartId,
  onClose,
  onSelect,
}: {
  open: boolean;
  parts: RecentDocumentEntry[];
  currentPartId: string | null;
  onClose: () => void;
  onSelect: (partId: string) => void;
}) {
  const handlePick = useCallback(
    (id: string) => {
      onSelect(id);
      onClose();
    },
    [onSelect, onClose],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4">
      <div
        className="relative flex w-full max-w-4xl flex-col rounded-lg border border-zinc-300 bg-white shadow-xl max-h-[min(90vh,720px)]"
        role="dialog"
        aria-labelledby="link-part-title"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 id="link-part-title" className="text-sm font-semibold text-zinc-900">
            Link part
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="shrink-0 px-4 pt-3 text-xs text-zinc-600">
          Choose a part document for this drawing. Views are projected from the linked part&apos;s solid geometry.
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {parts.length === 0 ? (
            <p className="text-sm text-zinc-500">No part documents found. Create a part from the home screen first.</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {parts.map((p) => (
                <PartLinkCard
                  key={p.id}
                  doc={p}
                  active={currentPartId === p.id}
                  onPick={() => handlePick(p.id)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
