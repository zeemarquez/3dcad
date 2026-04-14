import { Box, LayoutTemplate, ArrowLeftRight, ArrowUpDown } from 'lucide-react';
import { ToolBtn, Sep } from '@/modules/part/toolbar/ToolBtn';
import { useDrawingStore } from '../store/useDrawingStore';

export function DrawingTools({
  linkedPartId,
  linkedPartName,
  onPlaceView,
  onPlaceIsoView,
}: {
  linkedPartId: string | null;
  linkedPartName?: string;
  onPlaceView: () => void;
  onPlaceIsoView: () => void;
}) {
  const drawingDimensionMode = useDrawingStore((s) => s.drawingDimensionMode);
  const setDrawingDimensionMode = useDrawingStore((s) => s.setDrawingDimensionMode);

  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      <ToolBtn
        icon={LayoutTemplate}
        label="Place view"
        showLabel
        title="Insert an orthographic view of the linked part"
        onClick={onPlaceView}
      />
      <ToolBtn
        icon={Box}
        label="Iso view"
        showLabel
        title="Insert an isometric orthographic view — free placement on the sheet"
        onClick={onPlaceIsoView}
      />
      <Sep />
      <ToolBtn
        icon={ArrowLeftRight}
        label="H dim"
        variant="dimension"
        active={drawingDimensionMode === 'horizontal'}
        title="Horizontal dimension — horizontal edge length; two points; point then vertical line; hold Shift and pick a vertical edge, then a parallel vertical edge"
        onClick={() =>
          setDrawingDimensionMode(drawingDimensionMode === 'horizontal' ? null : 'horizontal')
        }
      />
      <ToolBtn
        icon={ArrowUpDown}
        label="V dim"
        variant="dimension"
        active={drawingDimensionMode === 'vertical'}
        title="Vertical dimension — vertical edge length; two points; point then horizontal line; hold Shift and pick a horizontal edge, then a parallel horizontal edge"
        onClick={() =>
          setDrawingDimensionMode(drawingDimensionMode === 'vertical' ? null : 'vertical')
        }
      />
      {linkedPartId && (
        <span className="ml-2 max-w-[200px] truncate text-xs text-zinc-600" title={linkedPartName}>
          Linked: {linkedPartName ?? linkedPartId.slice(0, 8) + '…'}
        </span>
      )}
    </div>
  );
}
