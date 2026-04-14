import { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { useDrawingStore, type DrawingViewPlacement } from '../store/useDrawingStore';

const LEGACY_VIEW_HEIGHT_RATIO = 0.75;

const labelCls = 'block text-xs font-medium text-zinc-600 mb-1.5';
const scaleInputClass =
  'w-16 rounded border border-zinc-300 bg-white px-2 py-1 text-sm tabular-nums text-zinc-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

function parsePositiveInt(raw: string, fallback: number): number {
  const t = raw.trim();
  if (!t) return fallback;
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function resolvedExtents(w: DrawingViewPlacement): { extX: number; extY: number; heightMm: number } {
  const num = w.viewScaleNum ?? 1;
  const den = w.viewScaleDen ?? w.viewScale ?? 1;
  const heightMm = w.heightMm ?? w.widthMm * LEGACY_VIEW_HEIGHT_RATIO;
  const extX = w.viewPlaneExtentXMm ?? (w.widthMm * den) / Math.max(1, num);
  const extY = w.viewPlaneExtentYMm ?? (heightMm * den) / Math.max(1, num);
  return { extX, extY, heightMm };
}

export function DrawingViewPropertiesSidebar() {
  const titleBlockSidebarOpen = useDrawingStore((s) => s.titleBlockSidebarOpen);
  const selectedViewId = useDrawingStore((s) => s.selectedViewId);
  const views = useDrawingStore((s) => s.views);
  const updateView = useDrawingStore((s) => s.updateView);
  const removeView = useDrawingStore((s) => s.removeView);
  const setSelectedViewId = useDrawingStore((s) => s.setSelectedViewId);
  const setPlaceViewDialogScale = useDrawingStore((s) => s.setPlaceViewDialogScale);

  const view = selectedViewId ? views.find((v) => v.id === selectedViewId) : undefined;

  const [scaleNumInput, setScaleNumInput] = useState('1');
  const [scaleDenInput, setScaleDenInput] = useState('1');

  useEffect(() => {
    if (!view) return;
    const num = view.viewScaleNum ?? 1;
    const den = view.viewScaleDen ?? view.viewScale ?? 1;
    setScaleNumInput(String(num));
    setScaleDenInput(String(den));
  }, [view?.id, view?.viewScaleNum, view?.viewScaleDen, view?.viewScale]);

  if (titleBlockSidebarOpen || !view) return null;

  const applyScaleFromInputs = () => {
    const newNum = parsePositiveInt(scaleNumInput, 1);
    const newDen = parsePositiveInt(scaleDenInput, 1);
    setScaleNumInput(String(newNum));
    setScaleDenInput(String(newDen));
    const { extX, extY } = resolvedExtents(view);
    const widthMm = (extX * newNum) / newDen;
    const heightMm = (extY * newNum) / newDen;
    updateView(view.id, {
      viewScaleNum: newNum,
      viewScaleDen: newDen,
      widthMm,
      heightMm,
      viewPlaneExtentXMm: extX,
      viewPlaneExtentYMm: extY,
    });
    setPlaceViewDialogScale(newNum, newDen);
  };

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-72 flex-col border-l border-zinc-300 bg-zinc-50 shadow-xl">
      <div className="flex h-full flex-col bg-zinc-50">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-300 bg-white p-3">
          <h2 className="text-sm font-semibold text-zinc-900">View</h2>
          <button
            type="button"
            onClick={() => setSelectedViewId(null)}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            aria-label="Close properties"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-3">
            <div>
              <span className={labelCls}>Scale (drawing : model)</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="drawing-view-scale-num"
                  inputMode="numeric"
                  value={scaleNumInput}
                  onChange={(e) => setScaleNumInput(e.target.value)}
                  onBlur={applyScaleFromInputs}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className={scaleInputClass}
                  aria-label="Scale numerator"
                />
                <span className="text-sm text-zinc-500">:</span>
                <input
                  id="drawing-view-scale-den"
                  inputMode="numeric"
                  value={scaleDenInput}
                  onChange={(e) => setScaleDenInput(e.target.value)}
                  onBlur={applyScaleFromInputs}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className={scaleInputClass}
                  aria-label="Scale denominator"
                />
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Example 1 : 2 is half size on the sheet; 2 : 1 is double.
              </p>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-zinc-300 bg-white p-3">
          <button
            type="button"
            onClick={() => removeView(view.id)}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800 transition-colors hover:bg-red-100"
          >
            <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
            Delete view
          </button>
        </div>
      </div>
    </div>
  );
}
