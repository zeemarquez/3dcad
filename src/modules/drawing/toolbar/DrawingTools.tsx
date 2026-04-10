import { LayoutTemplate, Link2, ArrowLeftRight, ArrowUpDown } from 'lucide-react';
import { ToolBtn, Sep } from '@/modules/part/toolbar/ToolBtn';
import { useDrawingStore } from '../store/useDrawingStore';

export function DrawingTools({
  linkedPartId,
  linkedPartName,
  onSetLinkedPart,
  onPlaceView,
}: {
  linkedPartId: string | null;
  linkedPartName?: string;
  onSetLinkedPart: () => void;
  onPlaceView: () => void;
}) {
  const drawingDimensionMode = useDrawingStore((s) => s.drawingDimensionMode);
  const setDrawingDimensionMode = useDrawingStore((s) => s.setDrawingDimensionMode);

  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      <ToolBtn
        icon={Link2}
        label="Link part"
        showLabel
        title="Choose which part this drawing references"
        onClick={onSetLinkedPart}
      />
      <Sep />
      <ToolBtn
        icon={LayoutTemplate}
        label="Place view"
        showLabel
        title="Insert an orthographic view of the linked part"
        onClick={onPlaceView}
      />
      <Sep />
      <ToolBtn
        icon={ArrowLeftRight}
        label="H dim"
        variant="dimension"
        active={drawingDimensionMode === 'horizontal'}
        title="Horizontal dimension — click a horizontal edge; or two vertices; or Shift+click a vertical edge then a second parallel vertical edge"
        onClick={() =>
          setDrawingDimensionMode(drawingDimensionMode === 'horizontal' ? null : 'horizontal')
        }
      />
      <ToolBtn
        icon={ArrowUpDown}
        label="V dim"
        variant="dimension"
        active={drawingDimensionMode === 'vertical'}
        title="Vertical dimension — click a vertical edge; or two vertices; or Shift+click a horizontal edge then a second parallel horizontal edge"
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
