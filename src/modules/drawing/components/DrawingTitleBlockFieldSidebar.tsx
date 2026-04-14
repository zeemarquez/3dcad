import { X } from 'lucide-react';
import { loadPartDocument } from '@/app/documentStore';
import { useDrawingStore } from '../store/useDrawingStore';
import { TITLE_BLOCK_VARIABLE_KEYS } from '../titleBlock/titleBlockModel';

const labelCls = 'block text-xs font-medium text-zinc-600 mb-1.5';

const labels: Record<string, string> = {
  title: 'Title',
  drawingNumber: 'Drawing number',
  scale: 'Scale',
  revision: 'Revision',
  date: 'Date',
  sheet: 'Sheet',
  company: 'Company / project',
  partName: 'Part name (linked)',
};

export function DrawingTitleBlockFieldSidebar() {
  const open = useDrawingStore((s) => s.titleBlockSidebarOpen);
  const linkedPartId = useDrawingStore((s) => s.linkedPartId);
  const fieldValues = useDrawingStore((s) => s.titleBlock.fieldValues);
  const resolvedPartName = linkedPartId ? loadPartDocument(linkedPartId)?.meta.name ?? '' : '';
  const setTitleBlockFieldValues = useDrawingStore((s) => s.setTitleBlockFieldValues);
  const setOpen = useDrawingStore((s) => s.setTitleBlockSidebarOpen);

  if (!open) return null;

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-72 flex-col border-l border-zinc-300 bg-zinc-50 shadow-xl">
      <div className="flex h-full flex-col bg-zinc-50">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-300 bg-white p-3">
          <h2 className="text-sm font-semibold text-zinc-900">Title block fields</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-xs text-zinc-500">
            Values for <code className="rounded bg-zinc-200/80 px-1">{`{{variable}}`}</code> placeholders in the table.
            Use the Drawing toolbar &quot;Title block&quot; button to edit layout and cell text.
          </p>
          <div className="space-y-3">
            {TITLE_BLOCK_VARIABLE_KEYS.map((key) => (
              <div key={key}>
                <label className={labelCls} htmlFor={`tb-field-${key}`}>
                  {labels[key] ?? key}
                </label>
                <input
                  id={`tb-field-${key}`}
                  type="text"
                  value={key === 'partName' ? resolvedPartName : (fieldValues[key] ?? '')}
                  onChange={(e) => {
                    if (key === 'partName') return;
                    setTitleBlockFieldValues({ [key]: e.target.value });
                  }}
                  readOnly={key === 'partName'}
                  className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 read-only:cursor-default read-only:bg-zinc-100"
                  placeholder={key === 'partName' ? 'From linked part' : undefined}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
