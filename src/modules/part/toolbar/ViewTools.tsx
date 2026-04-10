import { Grid3x3, Eye, EyeOff, Maximize2 } from 'lucide-react';
import { useCadStore } from '@/modules/part/store/useCadStore';
import { ToolBtn, Sep } from './ToolBtn';

export const ViewTools = () => {
  const { showGrid, toggleGrid, perspective, togglePerspective, setCameraView } = useCadStore();

  const views = [
    { id: 'front', label: 'Front', axis: 'F' },
    { id: 'back', label: 'Back', axis: 'B' },
    { id: 'left', label: 'Left', axis: 'L' },
    { id: 'right', label: 'Right', axis: 'R' },
    { id: 'top', label: 'Top', axis: 'T' },
    { id: 'bottom', label: 'Bottom', axis: 'Bo' },
    { id: 'isometric', label: 'Iso', axis: 'I' },
  ];

  return (
    <div className="flex items-center gap-1">
      <ToolBtn
        icon={showGrid ? Eye : EyeOff}
        label="Grid"
        active={showGrid}
        onClick={toggleGrid}
        title={showGrid ? 'Hide grid' : 'Show grid'}
      />
      <ToolBtn
        icon={Grid3x3}
        label={perspective ? 'Persp' : 'Ortho'}
        active={!perspective}
        onClick={togglePerspective}
        title={perspective ? 'Switch to orthographic' : 'Switch to perspective'}
      />

      <Sep />

      {views.map((v) => (
        <ToolBtn
          key={v.id}
          icon={Maximize2}
          label={v.label}
          onClick={() => setCameraView(v.id)}
          title={`${v.label} view`}
        />
      ))}
    </div>
  );
};
