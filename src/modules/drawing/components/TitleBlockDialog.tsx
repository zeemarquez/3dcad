import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useDrawingStore, type DrawingTitleBlockDocument } from '../store/useDrawingStore';
import { TitleBlockTableEditor } from './TitleBlockTableEditor';

export function TitleBlockDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const storeDoc = useDrawingStore((s) => s.titleBlock);
  const setTitleBlockDoc = useDrawingStore((s) => s.setTitleBlockDoc);
  const [draft, setDraft] = useState<DrawingTitleBlockDocument>(storeDoc);

  useEffect(() => {
    if (open) setDraft(JSON.parse(JSON.stringify(storeDoc)));
  }, [open, storeDoc]);

  if (!open) return null;

  const apply = () => {
    setTitleBlockDoc(draft);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/40 p-4">
      <div
        className="relative flex max-h-[min(92vh,880px)] w-full max-w-4xl flex-col rounded-lg border border-zinc-300 bg-white shadow-xl"
        role="dialog"
        aria-labelledby="title-block-dialog-title"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 id="title-block-dialog-title" className="text-sm font-semibold text-zinc-900">
            Title block layout
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <TitleBlockTableEditor doc={draft} setDoc={setDraft} />
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
