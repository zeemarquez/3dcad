import { useCallback, useEffect, useState } from 'react';
import * as THREE from 'three';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from 'lucide-react';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { DrawingOrthoPreview } from './DrawingOrthoPreview';
import { loadPartSolids } from '../loadPartSolids';
import { computePaperViewLayout } from '../computePaperViewWidth';
import { useDrawingStore } from '../store/useDrawingStore';

function rotateWorldAxis(q: THREE.Quaternion, axis: 'x' | 'y' | 'z', sign: 1 | -1): void {
  const rot = new THREE.Quaternion();
  const v =
    axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  rot.setFromAxisAngle(v, sign * (Math.PI / 2));
  q.premultiply(rot);
}

function quatToTuple(q: THREE.Quaternion): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}

/** Classic isometric: 45° about Y then ~35.264° about X (camera +Z, model rotated into view). */
function makeInitialIsometricQuaternion(): THREE.Quaternion {
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.atan(1 / Math.sqrt(2)));
  return new THREE.Quaternion().multiplyQuaternions(qx, qy);
}

const arrowBtn =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-zinc-300 bg-zinc-50 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-zinc-50';

const scaleInputClass =
  'w-16 rounded border border-zinc-300 bg-white px-2 py-1 text-sm tabular-nums text-zinc-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

function parsePositiveInt(raw: string, fallback: number): number {
  const t = raw.trim();
  if (!t) return fallback;
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export type PlaceViewConfirmPayload = {
  orientation: [number, number, number, number];
  widthMm: number;
  heightMm: number;
  viewPlaneExtentXMm: number;
  viewPlaneExtentYMm: number;
  viewScaleNum: number;
  viewScaleDen: number;
};

export function PlaceViewDialog({
  open,
  variant = 'standard',
  partId,
  maxViewWidthMm,
  maxViewHeightMm,
  onClose,
  onConfirm,
}: {
  open: boolean;
  /** Isometric: initial three-quarter view; arrow axes swapped 90° vs standard ortho. */
  variant?: 'standard' | 'isometric';
  partId: string | null;
  maxViewWidthMm: number;
  maxViewHeightMm: number;
  onClose: () => void;
  onConfirm: (payload: PlaceViewConfirmPayload) => void;
}) {
  const [solids, setSolids] = useState<SolidMeshData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState(() => new THREE.Quaternion());
  const [scaleNumInput, setScaleNumInput] = useState('1');
  const [scaleDenInput, setScaleDenInput] = useState('1');
  const setPlaceViewDialogScale = useDrawingStore((s) => s.setPlaceViewDialogScale);

  useEffect(() => {
    if (!open) return;
    setQ(variant === 'isometric' ? makeInitialIsometricQuaternion() : new THREE.Quaternion());
  }, [open, partId, variant]);

  useEffect(() => {
    if (!open) return;
    const { placeViewDialogScaleNum, placeViewDialogScaleDen } = useDrawingStore.getState();
    setScaleNumInput(String(placeViewDialogScaleNum));
    setScaleDenInput(String(placeViewDialogScaleDen));
  }, [open]);

  useEffect(() => {
    if (!open || !partId) {
      setSolids(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadPartSolids(partId)
      .then((s) => {
        if (!cancelled) setSolids(s);
      })
      .catch(() => {
        if (!cancelled) setSolids([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, partId]);

  const handleRotate = useCallback(
    (dir: 'up' | 'down' | 'left' | 'right') => {
      setQ((prev) => {
        const n = prev.clone();
        if (variant === 'isometric') {
          // 90° vs standard: screen up/down ↔ world Y, left/right ↔ world X
          if (dir === 'up') rotateWorldAxis(n, 'y', 1);
          else if (dir === 'down') rotateWorldAxis(n, 'y', -1);
          else if (dir === 'left') rotateWorldAxis(n, 'x', -1);
          else rotateWorldAxis(n, 'x', 1);
        } else {
          if (dir === 'up') rotateWorldAxis(n, 'x', 1);
          else if (dir === 'down') rotateWorldAxis(n, 'x', -1);
          else if (dir === 'left') rotateWorldAxis(n, 'y', -1);
          else rotateWorldAxis(n, 'y', 1);
        }
        return n;
      });
    },
    [variant],
  );

  const handleOk = useCallback(() => {
    if (!solids?.length) return;
    const viewScaleNum = parsePositiveInt(scaleNumInput, 1);
    const viewScaleDen = parsePositiveInt(scaleDenInput, 1);
    setPlaceViewDialogScale(viewScaleNum, viewScaleDen);
    const orientation = quatToTuple(q);
    const { widthMm, heightMm, viewPlaneExtentXMm, viewPlaneExtentYMm } = computePaperViewLayout(
      solids,
      orientation,
      viewScaleNum,
      viewScaleDen,
      { maxWidthMm: maxViewWidthMm, maxHeightMm: maxViewHeightMm },
    );
    onConfirm({
      orientation,
      widthMm,
      heightMm,
      viewPlaneExtentXMm,
      viewPlaneExtentYMm,
      viewScaleNum,
      viewScaleDen,
    });
    onClose();
  }, [solids, scaleNumInput, scaleDenInput, q, maxViewWidthMm, maxViewHeightMm, onConfirm, onClose, setPlaceViewDialogScale]);

  if (!open) return null;

  const emptyPart = !partId;
  const noGeometry = solids && solids.length === 0 && !loading;
  const disabledRotate = emptyPart || loading;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4">
      <div
        className="relative flex w-full max-w-2xl flex-col rounded-lg border border-zinc-300 bg-white shadow-xl"
        role="dialog"
        aria-labelledby="place-view-title"
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h2 id="place-view-title" className="text-sm font-semibold text-zinc-900">
            {variant === 'isometric' ? 'Place isometric view' : 'Place standard view'}
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

        <div className="flex flex-col items-center px-4 py-6">
          {emptyPart && (
            <div className="flex h-[220px] w-full max-w-md items-center justify-center rounded-md border border-dashed border-zinc-300 bg-zinc-50 text-sm text-zinc-500">
              A part must be linked when the drawing is created.
            </div>
          )}
          {!emptyPart && loading && (
            <div className="flex h-[220px] w-full max-w-md items-center justify-center rounded-md border border-zinc-200 bg-zinc-50">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-500" />
            </div>
          )}
          {!emptyPart && noGeometry && (
            <div className="flex h-[220px] w-full max-w-md items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 text-sm text-zinc-500">
              No solid geometry in this part yet.
            </div>
          )}
          {!emptyPart && solids && solids.length > 0 && (
            <div className="flex w-full max-w-lg flex-col items-center gap-1">
              <button
                type="button"
                className={arrowBtn}
                disabled={disabledRotate}
                title="Rotate 90° (up)"
                aria-label="Rotate view 90 degrees up"
                onClick={() => handleRotate('up')}
              >
                <ChevronUp className="h-6 w-6" strokeWidth={2} />
              </button>

              <div className="flex w-full max-w-md items-center justify-center gap-1">
                <button
                  type="button"
                  className={arrowBtn}
                  disabled={disabledRotate}
                  title="Rotate 90° (left)"
                  aria-label="Rotate view 90 degrees left"
                  onClick={() => handleRotate('left')}
                >
                  <ChevronLeft className="h-6 w-6" strokeWidth={2} />
                </button>

                <div className="min-h-[220px] min-w-0 flex-1 max-w-[420px]">
                  <DrawingOrthoPreview solids={solids} orientation={quatToTuple(q)} className="h-[240px]" />
                </div>

                <button
                  type="button"
                  className={arrowBtn}
                  disabled={disabledRotate}
                  title="Rotate 90° (right)"
                  aria-label="Rotate view 90 degrees right"
                  onClick={() => handleRotate('right')}
                >
                  <ChevronRight className="h-6 w-6" strokeWidth={2} />
                </button>
              </div>

              <button
                type="button"
                className={arrowBtn}
                disabled={disabledRotate}
                title="Rotate 90° (down)"
                aria-label="Rotate view 90 degrees down"
                onClick={() => handleRotate('down')}
              >
                <ChevronDown className="h-6 w-6" strokeWidth={2} />
              </button>

              <div className="mt-5 flex w-full max-w-md flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-zinc-700">Scale (drawing : model)</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="view-scale-num"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={scaleNumInput}
                      onChange={(e) => setScaleNumInput(e.target.value)}
                      onBlur={() => setScaleNumInput(String(parsePositiveInt(scaleNumInput, 1)))}
                      className={scaleInputClass}
                      aria-label="Scale numerator (drawing)"
                    />
                    <span className="text-sm font-medium text-zinc-600">:</span>
                    <input
                      id="view-scale-den"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={scaleDenInput}
                      onChange={(e) => setScaleDenInput(e.target.value)}
                      onBlur={() => setScaleDenInput(String(parsePositiveInt(scaleDenInput, 1)))}
                      className={scaleInputClass}
                      aria-label="Scale denominator (model)"
                    />
                  </div>
                </div>
                <p className="text-[10px] leading-snug text-zinc-500">
                  Whole numbers only. Model units are millimetres. Paper size = model projected size × (drawing ÷ model)
                  on both axes. Example 1 : 2 is half size; 2 : 1 is double. Uniformly scaled to fit the sheet inner area.
                </p>
              </div>

              <p className="mt-2 max-w-md text-center text-[10px] leading-snug text-zinc-500">
                {variant === 'isometric'
                  ? 'Arrows step 90° (up/down · Y, left/right · X). Isometric-style orthographic preview, line mode. View is free to position on the sheet.'
                  : 'Use the arrows to step orientation in 90° increments (up/down · X, left/right · Y). Orthographic preview, line mode.'}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={emptyPart || loading || !solids?.length}
            onClick={handleOk}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
