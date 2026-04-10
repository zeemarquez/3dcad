import type { ComponentType } from 'react';
import {
  Square,
  Circle,
  Minus,
  Spline,
  MoveHorizontal,
  MoveVertical,
  Link,
  Lock,
  Pause,
  Equal,
  LogOut,
  Trash2,
  CircleDashed,
  ArrowDownRight,
  CornerDownRight,
  Target,
  Crosshair,
  Ruler,
  ArrowLeftRight,
  ArrowUpDown,
  Diameter,
  TriangleRight,
  RotateCw,
  FlipHorizontal,
  Undo2,
  Redo2,
  Waves,
} from 'lucide-react';
import { useCadStore } from '@/modules/part/store/useCadStore';
import { useSketchStore, type ConstraintType } from '@/modules/part/store/useSketchStore';
import { ToolBtn, Sep } from './ToolBtn';

export const SketchTools = () => {
  const { activeCommand, setActiveCommand, exitSketchMode } = useCadStore();
  const {
    applyConstraint,
    beginConstraintSelection,
    clearPendingConstraintSelection,
    pendingConstraintType,
    deleteSelected,
    toggleAuxiliarySelected,
    selection,
    undoSketch,
    redoSketch,
  } = useSketchStore();
  const canUndoSketch = useSketchStore((s) => s.sketchUndoPast.length > 0);
  const canRedoSketch = useSketchStore((s) => s.sketchUndoFuture.length > 0);

  const hasCurveEntitySelected = selection.some(
    (s) =>
      s.type === 'line' || s.type === 'circle' || s.type === 'arc' || s.type === 'bspline'
  );

  const drawTools = [
    { id: 'line', label: 'Line', icon: Minus },
    { id: 'polyline', label: 'Polyline', icon: Spline },
    { id: 'bspline', label: 'B-Spline', icon: Waves },
    { id: 'circle', label: 'Circle', icon: Circle },
    { id: 'arc', label: 'Arc', icon: RotateCw },
    { id: 'rectangle', label: 'Rect', icon: Square },
  ];

  const constraintTools: { id: ConstraintType; label: string; icon: ComponentType<{ className?: string }> }[] = [
    { id: 'fix', label: 'Fix', icon: Lock },
    { id: 'coincident', label: 'Coincid.', icon: Link },
    { id: 'horizontal', label: 'Horiz.', icon: MoveHorizontal },
    { id: 'vertical', label: 'Vert.', icon: MoveVertical },
    { id: 'equal', label: 'Equal', icon: Equal },
    { id: 'parallel', label: 'Parallel', icon: Pause },
    { id: 'perpendicular', label: 'Perp.', icon: CornerDownRight },
    { id: 'tangent', label: 'Tangent', icon: ArrowDownRight },
    { id: 'concentric', label: 'Concent.', icon: Target },
    { id: 'midpoint', label: 'Midpoint', icon: Crosshair },
    { id: 'symmetry', label: 'Symmetry', icon: FlipHorizontal },
  ];

  const dimensionTools: { id: ConstraintType; label: string; icon: ComponentType<{ className?: string }> }[] = [
    { id: 'length', label: 'Length', icon: Ruler },
    { id: 'horizontalDistance', label: 'H Dist', icon: ArrowLeftRight },
    { id: 'verticalDistance', label: 'V Dist', icon: ArrowUpDown },
    { id: 'radius', label: 'Radius', icon: Diameter },
    { id: 'angle', label: 'Angle', icon: TriangleRight },
  ];

  const handleConstraintToolClick = (id: ConstraintType) => {
    if (pendingConstraintType === id) {
      clearPendingConstraintSelection();
      return;
    }
    if (selection.length > 0) {
      applyConstraint(id);
      clearPendingConstraintSelection();
      return;
    }
    beginConstraintSelection(id);
  };

  const commandDisabled = (id: ConstraintType) => !!pendingConstraintType && pendingConstraintType !== id;

  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      <ToolBtn icon={LogOut} label="Close" variant="danger" onClick={exitSketchMode} title="Close Sketch" />

      <Sep />

      <ToolBtn
        icon={Undo2}
        label="Undo"
        onClick={() => undoSketch()}
        disabled={!canUndoSketch}
        title="Undo (Ctrl+Z)"
      />
      <ToolBtn
        icon={Redo2}
        label="Redo"
        onClick={() => redoSketch()}
        disabled={!canRedoSketch}
        title="Redo (Ctrl+Y)"
      />

      <Sep />

      {drawTools.map((t) => (
        <ToolBtn
          key={t.id}
          icon={t.icon}
          label={t.label}
          active={activeCommand === t.id}
          onClick={() => setActiveCommand(activeCommand === t.id ? null : t.id)}
        />
      ))}

      <Sep />

      {constraintTools.map((t) => (
        <ToolBtn
          key={t.id}
          icon={t.icon}
          label={t.label}
          active={pendingConstraintType === t.id}
          variant="constraint"
          onClick={() => handleConstraintToolClick(t.id)}
          title={`${t.label} constraint`}
          disabled={commandDisabled(t.id)}
        />
      ))}

      <Sep />

      {dimensionTools.map((t) => (
        <ToolBtn
          key={t.id}
          icon={t.icon}
          label={t.label}
          active={pendingConstraintType === t.id}
          variant="dimension"
          onClick={() => handleConstraintToolClick(t.id)}
          title={`${t.label} dimension`}
          disabled={commandDisabled(t.id)}
        />
      ))}

      {selection.length > 0 && (
        <>
          <Sep />
          <ToolBtn
            icon={CircleDashed}
            label="Aux"
            onClick={toggleAuxiliarySelected}
            title="Toggle auxiliary (construction) geometry — dashed in sketch; ignored by extrude and regions"
            disabled={!hasCurveEntitySelected}
          />
          <ToolBtn icon={Trash2} label="Delete" variant="danger" onClick={deleteSelected} title="Delete selected" />
        </>
      )}
    </div>
  );
};
