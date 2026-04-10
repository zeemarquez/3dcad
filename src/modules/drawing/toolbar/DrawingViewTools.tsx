import { Grid3x3, Minus, Plus } from 'lucide-react';
import { ToolBtn, Sep } from '@/modules/part/toolbar/ToolBtn';
import { useDrawingStore } from '../store/useDrawingStore';

export const DrawingViewTools = () => {
  const showSheetGrid = useDrawingStore((s) => s.showSheetGrid);
  const toggleSheetGrid = useDrawingStore((s) => s.toggleSheetGrid);
  const sheetZoom = useDrawingStore((s) => s.sheetZoom);
  const setSheetZoom = useDrawingStore((s) => s.setSheetZoom);

  return (
    <div className="flex items-center gap-1">
      <ToolBtn
        icon={Grid3x3}
        label="Grid"
        active={showSheetGrid}
        onClick={toggleSheetGrid}
        title={showSheetGrid ? 'Hide sheet grid' : 'Show sheet grid'}
      />
      <Sep />
      <ToolBtn
        icon={Minus}
        label="Zoom −"
        showLabel={false}
        onClick={() => setSheetZoom(sheetZoom / 1.12)}
        title="Zoom sheet out"
      />
      <ToolBtn
        icon={Plus}
        label="Zoom +"
        showLabel={false}
        onClick={() => setSheetZoom(sheetZoom * 1.12)}
        title="Zoom sheet in"
      />
      <span className="text-[10px] text-zinc-500 tabular-nums">{Math.round(sheetZoom * 100)}%</span>
    </div>
  );
};
