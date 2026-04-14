import { X } from 'lucide-react';

export type DrawingExportFormat = 'pdf' | 'dwg' | 'svg';

export function DrawingDownloadFormatDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (format: DrawingExportFormat) => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/40 p-4">
      <div
        className="relative flex w-full max-w-sm flex-col rounded-lg border border-zinc-300 bg-white shadow-xl"
        role="dialog"
        aria-labelledby="download-format-title"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 id="download-format-title" className="text-sm font-semibold text-zinc-900">
            Download drawing
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
        <p className="px-4 pt-3 text-xs text-zinc-600">Choose a file format.</p>
        <div className="flex flex-col gap-2 px-4 py-4">
          <button
            type="button"
            onClick={() => onConfirm('pdf')}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            PDF
          </button>
          <button
            type="button"
            onClick={() => onConfirm('dwg')}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            DWG
          </button>
          <button
            type="button"
            onClick={() => onConfirm('svg')}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-left text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            SVG
          </button>
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
