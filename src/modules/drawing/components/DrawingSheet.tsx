import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';
import {
  useDrawingStore,
  A4_WIDTH_MM,
  A4_HEIGHT_MM,
  inferViewAlignment,
  type DrawingDimensionMode,
  type DrawingViewAlignment,
  type DrawingViewPlacement,
} from '../store/useDrawingStore';
import { DrawingOrthoPreview } from './DrawingOrthoPreview';

/** Older placements without heightMm used this factor on width. */
const VIEW_HEIGHT_RATIO_LEGACY = 0.75;

function viewPlaneHalfExtentsMm(v: DrawingViewPlacement): { x: number; y: number } {
  const ex = v.viewPlaneExtentXMm;
  const ey = v.viewPlaneExtentYMm;
  if (ex != null && ey != null && ex > 0 && ey > 0) {
    return { x: ex / 2, y: ey / 2 };
  }
  const num = v.viewScaleNum ?? 1;
  const den = v.viewScaleDen ?? v.viewScale ?? 1;
  const hPaper = v.heightMm ?? v.widthMm * VIEW_HEIGHT_RATIO_LEGACY;
  return { x: ((v.widthMm * den) / num) / 2, y: ((hPaper * den) / num) / 2 };
}

const BASE_PX_PER_MM = 2.8;

/**
 * Extra CSS px around the letterboxed model area → widens the ortho frustum so linear dimensions
 * can sit far outside the silhouette without WebGL clipping. Scales with view size.
 */
function viewCanvasGutterPx(innerW: number, innerH: number): number {
  const m = Math.min(innerW, innerH);
  return Math.max(220, Math.round(m * 0.62));
}

type DragState = {
  viewId: string;
  viewIndex: number;
  pointerId: number;
  captureTarget: HTMLElement;
  startClientX: number;
  startClientY: number;
  originSheetX: number;
  originSheetY: number;
};

function cursorForAlignment(alignment: DrawingViewAlignment | undefined, index: number): string {
  const a = alignment ?? inferViewAlignment(index);
  if (a === 'vertical') return 'ns-resize';
  if (a === 'horizontal') return 'ew-resize';
  return 'move';
}

/**
 * View drag / view context menu: inside the blue view frame, but not in the canvas gutter
 * (extra frustum margin for dimensions). Letterbox bars outside that gutter remain draggable.
 * `x`/`y` are relative to the view frame top-left.
 */
function isInViewFrameExcludingDimensionGutter(
  x: number,
  y: number,
  viewFrameHeightPx: number,
  insetX: number,
  insetY: number,
  innerW: number,
  innerH: number,
  canvasGutterPx: number,
): boolean {
  const top = viewFrameHeightPx - insetY - innerH;
  const bottom = viewFrameHeightPx - insetY;
  const left = insetX;
  const right = insetX + innerW;
  const g = canvasGutterPx;

  if (x >= left && x <= right && y >= top && y <= bottom) return true;

  const gl = left - g;
  const gr = right + g;
  const gt = top - g;
  const gb = bottom + g;
  const inGutterRing = x >= gl && x <= gr && y >= gt && y <= gb;
  const inLetterbox = x >= left && x <= right && y >= top && y <= bottom;
  if (inGutterRing && !inLetterbox) return false;

  return true;
}

type SheetPanDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  originPanX: number;
  originPanY: number;
};

function wheelDeltaPixels(e: WheelEvent): { dx: number; dy: number } {
  let dx = e.deltaX;
  let dy = e.deltaY;
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    dx *= 16;
    dy *= 16;
  } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    dy *= 400;
    dx *= 400;
  }
  return { dx, dy };
}

/** Blue view frame + pointer capture so cursor matches view-drag hit region (excludes dimension gutter). */
function DrawingSheetViewBox({
  viewIndex,
  placement,
  left,
  bottom,
  wPx,
  hPx,
  insetX,
  insetY,
  innerW,
  innerH,
  canvasGutterPx,
  stackZIndex,
  selected,
  drawingDimensionMode,
  dimHoverThisView,
  onPointerDown,
  onContextMenu,
  children,
}: {
  viewIndex: number;
  placement: DrawingViewPlacement;
  left: number;
  bottom: number;
  wPx: number;
  hPx: number;
  insetX: number;
  insetY: number;
  innerW: number;
  innerH: number;
  canvasGutterPx: number;
  /** Later DOM siblings paint on top; use this so principal / selected views receive hits when boxes overlap. */
  stackZIndex: number;
  selected: boolean;
  drawingDimensionMode: DrawingDimensionMode;
  dimHoverThisView: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu: (e: ReactPointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const [inViewDragChrome, setInViewDragChrome] = useState(false);

  const syncChromeFromEvent = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inBlueFrame = x >= 0 && x <= wPx && y >= 0 && y <= hPx;
    setInViewDragChrome(
      inBlueFrame &&
        isInViewFrameExcludingDimensionGutter(
          x,
          y,
          hPx,
          insetX,
          insetY,
          innerW,
          innerH,
          canvasGutterPx,
        ),
    );
  };

  const cursor =
    drawingDimensionMode
      ? 'crosshair'
      : dimHoverThisView
        ? 'grab'
        : inViewDragChrome
          ? cursorForAlignment(placement.alignment ?? inferViewAlignment(viewIndex), viewIndex)
          : 'default';

  return (
    <div
      className={`box-border absolute overflow-visible rounded-sm bg-transparent ${
        selected ? 'ring-2 ring-blue-500 ring-offset-1' : ''
      }`}
      style={{
        left,
        bottom,
        width: wPx,
        height: hPx,
        zIndex: stackZIndex,
        cursor,
      }}
      onPointerMoveCapture={syncChromeFromEvent}
      onPointerLeave={() => setInViewDragChrome(false)}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      <div
        className="pointer-events-auto absolute z-[5] overflow-visible"
        style={{
          left: insetX - canvasGutterPx,
          bottom: insetY - canvasGutterPx,
          width: innerW + 2 * canvasGutterPx,
          height: innerH + 2 * canvasGutterPx,
          cursor,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function DrawingSheet({ solids, loadingSolids }: { solids: SolidMeshData[] | null; loadingSolids: boolean }) {
  const sheet = useDrawingStore((s) => s.sheet);
  const views = useDrawingStore((s) => s.views);
  const selectedViewId = useDrawingStore((s) => s.selectedViewId);
  const setSelectedViewId = useDrawingStore((s) => s.setSelectedViewId);
  const movePrimaryOnSheet = useDrawingStore((s) => s.movePrimaryOnSheet);
  const showSheetGrid = useDrawingStore((s) => s.showSheetGrid);
  const sheetZoom = useDrawingStore((s) => s.sheetZoom);
  const sheetPan = useDrawingStore((s) => s.sheetPan);
  const setSheetPan = useDrawingStore((s) => s.setSheetPan);
  const removeView = useDrawingStore((s) => s.removeView);
  const linkedPartId = useDrawingStore((s) => s.linkedPartId);
  const drawingDimensionMode = useDrawingStore((s) => s.drawingDimensionMode);
  const setDrawingDimensionMode = useDrawingStore((s) => s.setDrawingDimensionMode);
  const dimensions = useDrawingStore((s) => s.dimensions);
  const addDimension = useDrawingStore((s) => s.addDimension);
  const updateDimensionGeometry = useDrawingStore((s) => s.updateDimensionGeometry);
  const removeDimension = useDrawingStore((s) => s.removeDimension);
  const hoveredDimensionId = useDrawingStore((s) => s.hoveredDimensionId);
  const setSelectedDimensionId = useDrawingStore((s) => s.setSelectedDimensionId);

  const pxPerMm = BASE_PX_PER_MM * sheetZoom;
  const sheetW = sheet.widthMm * pxPerMm;
  const sheetH = sheet.heightMm * pxPerMm;

  const viewportRef = useRef<HTMLDivElement>(null);
  const sheetPanDragRef = useRef<SheetPanDrag | null>(null);

  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const st = useDrawingStore.getState();
      const sh = st.sheet;
      const z0 = st.sheetZoom;
      const pan = st.sheetPan;

      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const vcx = rect.width / 2;
      const vcy = rect.height / 2;

      if (e.ctrlKey) {
        e.preventDefault();
        const z1 = Math.min(4, Math.max(0.25, z0 * Math.exp(-e.deltaY * 0.002)));
        if (z1 === z0) return;

        const px0 = BASE_PX_PER_MM * z0;
        const px1 = BASE_PX_PER_MM * z1;
        const sw0 = sh.widthMm * px0;
        const sh0 = sh.heightMm * px0;
        const sw1 = sh.widthMm * px1;
        const sh1 = sh.heightMm * px1;

        const sheetLeft = vcx + pan.x - sw0 / 2;
        const sheetTop = vcy + pan.y - sh0 / 2;
        const mmX = (mx - sheetLeft) / px0;
        const mmY = (my - sheetTop) / px0;

        const panXNew = mx - vcx - mmX * px1 + sw1 / 2;
        const panYNew = my - vcy - mmY * px1 + sh1 / 2;

        useDrawingStore.setState({ sheetZoom: z1, sheetPan: { x: panXNew, y: panYNew } });
        return;
      }

      e.preventDefault();
      const { dx, dy } = wheelDeltaPixels(e);
      useDrawingStore.setState({
        sheetPan: { x: pan.x - dx, y: pan.y - dy },
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dxMm = (e.clientX - d.startClientX) / pxPerMm;
      const dyMm = -(e.clientY - d.startClientY) / pxPerMm;

      const store = useDrawingStore.getState();
      const currentViews = store.views;
      const primary = currentViews[0];

      if (d.viewIndex === 0) {
        movePrimaryOnSheet(d.originSheetX + dxMm, d.originSheetY + dyMm);
        return;
      }

      const w = currentViews[d.viewIndex];
      if (!primary || !w) return;
      const al = w.alignment ?? inferViewAlignment(d.viewIndex);
      if (al === 'vertical') {
        store.updateView(d.viewId, { sheetX: primary.sheetX, sheetY: d.originSheetY + dyMm });
      } else if (al === 'horizontal') {
        store.updateView(d.viewId, { sheetX: d.originSheetX + dxMm, sheetY: primary.sheetY });
      } else if (al === 'free') {
        store.updateView(d.viewId, { sheetX: d.originSheetX + dxMm, sheetY: d.originSheetY + dyMm });
      }
    },
    [pxPerMm, movePrimaryOnSheet],
  );

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (d) {
      try {
        d.captureTarget.releasePointerCapture(d.pointerId);
      } catch {
        /* already released */
      }
    }
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }, [onPointerMove]);

  const startDrag = useCallback(
    (
      e: React.PointerEvent,
      viewId: string,
      viewIndex: number,
      sheetX: number,
      sheetY: number,
    ) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        viewId,
        viewIndex,
        pointerId: e.pointerId,
        captureTarget: e.currentTarget as HTMLElement,
        startClientX: e.clientX,
        startClientY: e.clientY,
        originSheetX: sheetX,
        originSheetY: sheetY,
      };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
    },
    [onPointerMove, endDrag],
  );

  useEffect(() => () => endDrag(), [endDrag]);

  const [dimensionContextMenu, setDimensionContextMenu] = useState<{
    x: number;
    y: number;
    dimensionId: string;
  } | null>(null);
  const dimensionContextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawingDimensionMode(null);
        setSelectedDimensionId(null);
        setDimensionContextMenu(null);
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      const id = useDrawingStore.getState().selectedDimensionId;
      if (!id) return;
      e.preventDefault();
      removeDimension(id);
      setDimensionContextMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [removeDimension, setDrawingDimensionMode, setSelectedDimensionId]);

  const onAddViewDimension = useCallback(
    (d: Parameters<typeof addDimension>[0]) => {
      addDimension(d);
    },
    [addDimension],
  );

  const onUpdateDimGeometry = useCallback(
    (id: string, patch: { offsetMm?: number; alongMm?: number }) => {
      updateDimensionGeometry(id, patch);
    },
    [updateDimensionGeometry],
  );

  const [sheetViewportPanning, setSheetViewportPanning] = useState(false);
  const [viewContextMenu, setViewContextMenu] = useState<{ x: number; y: number; viewId: string } | null>(null);
  const viewContextMenuRef = useRef<HTMLDivElement>(null);

  const onDimensionContextMenu = useCallback(
    (detail: { dimensionId: string; clientX: number; clientY: number }) => {
      setViewContextMenu(null);
      setDimensionContextMenu({
        x: detail.clientX,
        y: detail.clientY,
        dimensionId: detail.dimensionId,
      });
    },
    [],
  );

  useEffect(() => {
    if (!viewContextMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (viewContextMenuRef.current?.contains(e.target as Node)) return;
      setViewContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewContextMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [viewContextMenu]);

  useEffect(() => {
    if (!dimensionContextMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (dimensionContextMenuRef.current?.contains(e.target as Node)) return;
      setDimensionContextMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDimensionContextMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [dimensionContextMenu]);

  const onViewportPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const st = useDrawingStore.getState();
    sheetPanDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originPanX: st.sheetPan.x,
      originPanY: st.sheetPan.y,
    };
    setSheetViewportPanning(true);
  }, []);

  const onViewportPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = sheetPanDragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      setSheetPan({ x: d.originPanX + dx, y: d.originPanY + dy });
    },
    [setSheetPan],
  );

  const endSheetViewportPan = useCallback((e: React.PointerEvent) => {
    const d = sheetPanDragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    sheetPanDragRef.current = null;
    setSheetViewportPanning(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
  }, []);

  const marginMm = 12;
  const innerW = sheet.widthMm - marginMm * 2;
  const innerH = sheet.heightMm - marginMm * 2;

  return (
    <div
      ref={viewportRef}
      className={`relative h-full w-full min-h-0 overflow-visible bg-zinc-300/90 ${sheetViewportPanning ? 'cursor-grabbing' : ''}`}
      style={{ touchAction: 'none' }}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={endSheetViewportPan}
      onPointerCancel={endSheetViewportPan}
      title="Scroll to pan · Ctrl+scroll or pinch to zoom · Middle-drag to pan"
    >
      <div
        className="relative overflow-visible shadow-lg"
        style={{
          position: 'absolute',
          left: `calc(50% + ${sheetPan.x}px)`,
          top: `calc(50% + ${sheetPan.y}px)`,
          width: sheetW,
          height: sheetH,
          marginLeft: -sheetW / 2,
          marginTop: -sheetH / 2,
        }}
        onPointerDown={() => setSelectedViewId(null)}
      >
        <svg
          width={sheetW}
          height={sheetH}
          className="absolute inset-0 block bg-white"
          aria-hidden
        >
          <defs>
            <pattern
              id="drawingGrid"
              width={pxPerMm * 5}
              height={pxPerMm * 5}
              patternUnits="userSpaceOnUse"
            >
              <path
                d={`M ${pxPerMm * 5} 0 L 0 0 0 ${pxPerMm * 5}`}
                fill="none"
                stroke="#e4e4e7"
                strokeWidth={0.5}
              />
            </pattern>
          </defs>
          {showSheetGrid && <rect width="100%" height="100%" fill="url(#drawingGrid)" />}
          <rect
            x={marginMm * pxPerMm}
            y={marginMm * pxPerMm}
            width={innerW * pxPerMm}
            height={innerH * pxPerMm}
            fill="none"
            stroke="#27272a"
            strokeWidth={1.25}
          />
        </svg>

        {loadingSolids && linkedPartId && (
          <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded bg-white/90 px-2 py-1 text-[10px] text-zinc-600 shadow">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-300 border-t-blue-500" />
            Updating part preview…
          </div>
        )}

        {views.map((v, viewIndex) => {
          const heightMm = v.heightMm ?? v.widthMm * VIEW_HEIGHT_RATIO_LEGACY;
          const wPx = v.widthMm * pxPerMm;
          const hPx = heightMm * pxPerMm;
          const left = (v.sheetX - v.widthMm / 2) * pxPerMm;
          const bottom = (v.sheetY - heightMm / 2) * pxPerMm;
          const selected = selectedViewId === v.id;
          const dimHoverThisView =
            !!hoveredDimensionId &&
            dimensions.some((d) => d.id === hoveredDimensionId && d.viewId === v.id);

          const paperAspect = v.widthMm / heightMm;
          const outerAspect = wPx / Math.max(hPx, 1e-6);
          let innerW: number;
          let innerH: number;
          let insetX: number;
          let insetY: number;
          if (outerAspect > paperAspect) {
            innerH = hPx;
            innerW = innerH * paperAspect;
            insetX = (wPx - innerW) / 2;
            insetY = 0;
          } else {
            innerW = wPx;
            innerH = innerW / paperAspect;
            insetX = 0;
            insetY = (hPx - innerH) / 2;
          }

          const canvasGutterPx = viewCanvasGutterPx(innerW, innerH);

          /** Without z-index, later `views.map` siblings stack above earlier ones; tall views + dimension gutters often overlap the principal view and steal pointer events. */
          const stackZIndex =
            (views.length - 1 - viewIndex) * 10 + (selected ? 500 : 0);

          return (
            <DrawingSheetViewBox
              key={v.id}
              viewIndex={viewIndex}
              placement={v}
              left={left}
              bottom={bottom}
              wPx={wPx}
              hPx={hPx}
              insetX={insetX}
              insetY={insetY}
              innerW={innerW}
              innerH={innerH}
              canvasGutterPx={canvasGutterPx}
              stackZIndex={stackZIndex}
              selected={selected}
              drawingDimensionMode={drawingDimensionMode}
              dimHoverThisView={dimHoverThisView}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                if (x < 0 || x > wPx || y < 0 || y > hPx) return;
                if (
                  !isInViewFrameExcludingDimensionGutter(
                    x,
                    y,
                    hPx,
                    insetX,
                    insetY,
                    innerW,
                    innerH,
                    canvasGutterPx,
                  )
                ) {
                  return;
                }
                const blockViewDrag =
                  !!drawingDimensionMode ||
                  (!!hoveredDimensionId &&
                    dimensions.some((d) => d.id === hoveredDimensionId && d.viewId === v.id));
                if (blockViewDrag) return;
                e.stopPropagation();
                setSelectedViewId(v.id);
                startDrag(e, v.id, viewIndex, v.sheetX, v.sheetY);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                if (x < 0 || x > wPx || y < 0 || y > hPx) return;
                if (
                  !isInViewFrameExcludingDimensionGutter(
                    x,
                    y,
                    hPx,
                    insetX,
                    insetY,
                    innerW,
                    innerH,
                    canvasGutterPx,
                  )
                ) {
                  return;
                }
                e.stopPropagation();
                setSelectedViewId(v.id);
                setDimensionContextMenu(null);
                setViewContextMenu({ x: e.clientX, y: e.clientY, viewId: v.id });
              }}
            >
              {solids && solids.length > 0 ? (
                <DrawingOrthoPreview
                  solids={solids}
                  orientation={v.orientation}
                  viewPlaneHalfExtentsMm={viewPlaneHalfExtentsMm(v)}
                  className="!min-h-0 !h-full !w-full !rounded-none !border-0"
                  viewId={v.id}
                  dimensionMode={drawingDimensionMode}
                  dimensions={dimensions.filter((d) => d.viewId === v.id)}
                  onAddDimension={onAddViewDimension}
                  onUpdateDimensionGeometry={onUpdateDimGeometry}
                  onDimensionContextMenu={onDimensionContextMenu}
                  canvasGutterPx={canvasGutterPx}
                />
              ) : (
                <div className="flex h-full min-h-0 items-center justify-center bg-zinc-50 text-[10px] text-zinc-500">
                  {linkedPartId ? 'No solid' : 'No part'}
                </div>
              )}
            </DrawingSheetViewBox>
          );
        })}
      </div>

      {viewContextMenu &&
        createPortal(
          <div
            ref={viewContextMenuRef}
            className="fixed z-[300] min-w-[160px] rounded-md border border-zinc-200 bg-white py-1 shadow-lg"
            style={{
              left: Math.max(8, Math.min(viewContextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 168)),
              top: Math.max(8, Math.min(viewContextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - 44)),
            }}
            role="menu"
            aria-label="View actions"
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
              onClick={() => {
                removeView(viewContextMenu.viewId);
                setViewContextMenu(null);
              }}
            >
              Delete view
            </button>
          </div>,
          document.body,
        )}

      {dimensionContextMenu &&
        createPortal(
          <div
            ref={dimensionContextMenuRef}
            className="fixed z-[301] min-w-[160px] rounded-md border border-zinc-200 bg-white py-1 shadow-lg"
            style={{
              left: Math.max(
                8,
                Math.min(
                  dimensionContextMenu.x,
                  (typeof window !== 'undefined' ? window.innerWidth : 9999) - 168,
                ),
              ),
              top: Math.max(
                8,
                Math.min(
                  dimensionContextMenu.y,
                  (typeof window !== 'undefined' ? window.innerHeight : 9999) - 44,
                ),
              ),
            }}
            role="menu"
            aria-label="Dimension actions"
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
              onClick={() => {
                removeDimension(dimensionContextMenu.dimensionId);
                setDimensionContextMenu(null);
              }}
            >
              Delete dimension
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
