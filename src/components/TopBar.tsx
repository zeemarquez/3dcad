import React, { useState } from 'react';
import { useCadStore } from '../store/useCadStore';
import { useSketchStore, type ConstraintType } from '../store/useSketchStore';
import {
  Home,
  Square,
  Circle,
  PenTool,
  Box,
  Scissors,
  RotateCw,
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
  Grid3x3,
  Eye,
  EyeOff,
  Maximize2,
  Axis3d,
  SlidersHorizontal,
  FilePenLine,
  Save,
  Download,
  CopyPlus,
  Boxes,
  FileArchive,
  FlipHorizontal,
  Undo2,
  Redo2,
} from 'lucide-react';

const partIcons = {
  sketch: new URL('../assets/toolbar-icons/part/sketch.png', import.meta.url).href,
  extrude: new URL('../assets/toolbar-icons/part/extrude.png', import.meta.url).href,
  cut: new URL('../assets/toolbar-icons/part/cut.png', import.meta.url).href,
  revolve: new URL('../assets/toolbar-icons/part/revolve.png', import.meta.url).href,
  revolveCut: new URL('../assets/toolbar-icons/part/revolve-cut.png', import.meta.url).href,
  fillet: new URL('../assets/toolbar-icons/part/fillet.png', import.meta.url).href,
  chamfer: new URL('../assets/toolbar-icons/part/chamfer.png', import.meta.url).href,
  plane: new URL('../assets/toolbar-icons/part/plane.png', import.meta.url).href,
  point: new URL('../assets/toolbar-icons/part/point.png', import.meta.url).href,
  axis: new URL('../assets/toolbar-icons/part/axis.png', import.meta.url).href,
} as const;

// ─── Shared button component ─────────────────────────────────────────────────
const ToolBtn: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  variant?: 'default' | 'constraint' | 'dimension' | 'danger';
  onClick: () => void;
  title?: string;
  iconSrc?: string;
  iconAlt?: string;
  showLabel?: boolean;
  disabled?: boolean;
}> = ({ icon: Icon, label, active, variant = 'default', onClick, title, iconSrc, iconAlt, showLabel = true, disabled = false }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const ring =
    variant === 'constraint'
      ? 'hover:border-blue-500/50'
      : variant === 'dimension'
      ? 'hover:border-amber-500/50'
      : variant === 'danger'
      ? 'border-red-500/40 hover:border-red-400'
      : 'hover:border-zinc-300';
  const bg =
    variant === 'danger'
      ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400'
      : 'bg-white hover:bg-zinc-100';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={`flex flex-col items-center justify-center w-14 h-12 rounded-md border transition-colors ${
        active
          ? 'bg-blue-600/20 border-blue-500 text-blue-500'
          : `${bg} border-zinc-300 ${ring}`
      } ${disabled ? 'opacity-45 cursor-not-allowed hover:bg-white hover:border-zinc-300' : ''}`}
    >
      {iconSrc && !imgFailed ? (
        <img
          src={iconSrc}
          alt={iconAlt ?? label}
          onError={() => setImgFailed(true)}
          className={`w-9 h-9 object-contain ${showLabel ? 'mb-0.5' : ''}`}
        />
      ) : (
        <Icon className={`w-6 h-6 stroke-[1.5] ${showLabel ? 'mb-0.5' : ''}`} />
      )}
      {showLabel && <span className="text-[9px] font-medium leading-tight whitespace-nowrap">{label}</span>}
    </button>
  );
};

const Sep = () => <div className="w-px self-stretch bg-zinc-300 mx-1 shrink-0" />;

// ─── Part toolbar content ────────────────────────────────────────────────────
const PartTools = () => {
  const { activeCommand, setActiveCommand, openParametersDialog } = useCadStore();

  return (
    <div className="flex items-center gap-1">
      {/* Group 1: Sketch */}
      <ToolBtn
        icon={PenTool}
        label="Sketch"
        title="Sketch"
        showLabel={false}
        iconSrc={partIcons.sketch}
        active={activeCommand === 'sketch'}
        onClick={() => setActiveCommand(activeCommand === 'sketch' ? null : 'sketch')}
      />

      <Sep />

      {/* Group 2: Solid operations */}
      {[
        { id: 'extrude', label: 'Extrude', icon: Box, iconSrc: partIcons.extrude },
        { id: 'cut', label: 'Cut', icon: Scissors, iconSrc: partIcons.cut },
        { id: 'revolve', label: 'Revolve', icon: RotateCw, iconSrc: partIcons.revolve },
        { id: 'revolveCut', label: 'Revolve cut', icon: Scissors, iconSrc: partIcons.revolveCut },
        { id: 'fillet', label: 'Fillet', icon: Circle, iconSrc: partIcons.fillet },
        { id: 'chamfer', label: 'Chamfer', icon: CornerDownRight, iconSrc: partIcons.chamfer },
      ].map((t) => (
        <ToolBtn
          key={t.id}
          icon={t.icon}
          label={t.label}
          title={t.label}
          showLabel={false}
          iconSrc={t.iconSrc}
          active={activeCommand === t.id}
          onClick={() => setActiveCommand(activeCommand === t.id ? null : t.id)}
        />
      ))}

      <Sep />

      {/* Group 3: Reference geometry */}
      {[
        { id: 'plane', label: 'Plane', icon: Square, iconSrc: partIcons.plane },
        { id: 'point', label: 'Point', icon: Circle, iconSrc: partIcons.point },
        { id: 'axis', label: 'Axis', icon: Axis3d, iconSrc: partIcons.axis },
      ].map((t) => (
        <ToolBtn
          key={t.id}
          icon={t.icon}
          label={t.label}
          title={t.label}
          showLabel={false}
          iconSrc={t.iconSrc}
          active={activeCommand === t.id}
          onClick={() => setActiveCommand(activeCommand === t.id ? null : t.id)}
        />
      ))}

      <Sep />
      <ToolBtn
        icon={SlidersHorizontal}
        label="Parameters"
        title="Parameters"
        showLabel={false}
        onClick={openParametersDialog}
      />
    </div>
  );
};

// ─── Sketch toolbar content ──────────────────────────────────────────────────
const SketchTools = () => {
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
    (s) => s.type === 'line' || s.type === 'circle' || s.type === 'arc'
  );

  const drawTools = [
    { id: 'line', label: 'Line', icon: Minus },
    { id: 'polyline', label: 'Polyline', icon: Spline },
    { id: 'circle', label: 'Circle', icon: Circle },
    { id: 'arc', label: 'Arc', icon: RotateCw },
    { id: 'rectangle', label: 'Rect', icon: Square },
  ];

  const constraintTools: { id: ConstraintType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
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

  const dimensionTools: { id: ConstraintType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
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

// ─── View toolbar content ────────────────────────────────────────────────────
const ViewTools = () => {
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

      {/* View orientations */}
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

// ─── Main TopBar ─────────────────────────────────────────────────────────────
type RibbonTab = 'file' | 'main' | 'view';

interface FileToolbarActions {
  onRenameDocument: () => void;
  onSaveAs: () => void;
  onDownloadPar: () => void;
  onCreateCopy: () => void;
  onExportStep: () => void;
  onExportStl: () => void;
}

const FileToolbar: React.FC<{
  documentName?: string;
  actions: FileToolbarActions;
}> = ({ documentName: _documentName, actions }) => {
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      <ToolBtn icon={FilePenLine} label="Rename" showLabel={false} title="Rename document" onClick={actions.onRenameDocument} />
      <ToolBtn icon={Save} label="Save As" showLabel={false} title="Save As..." onClick={actions.onSaveAs} />
      <ToolBtn icon={Download} label="Download" showLabel={false} title="Download .par" onClick={actions.onDownloadPar} />
      <ToolBtn icon={CopyPlus} label="Copy" showLabel={false} title="Create copy" onClick={actions.onCreateCopy} />
      <Sep />
      <ToolBtn icon={Boxes} label="STEP" showLabel={false} title="Export STEP" onClick={actions.onExportStep} />
      <ToolBtn icon={FileArchive} label="STL" showLabel={false} title="Export STL" onClick={actions.onExportStl} />
    </div>
  );
};

export const TopBar: React.FC<{
  onHomeClick?: () => void;
  documentName?: string;
  fileActions?: FileToolbarActions;
}> = ({ onHomeClick, documentName, fileActions }) => {
  const { activeModule } = useCadStore();
  const isSketch = activeModule === 'sketch';

  const [activeTab, setActiveTab] = useState<RibbonTab>('main');

  const mainLabel = isSketch ? 'Sketch' : 'Part';

  return (
    <div className="flex flex-col w-full z-20 select-none">
      {/* ── Tab strip ────────────────────────────────────────────────────── */}
      <div className="flex items-center bg-zinc-100 border-b border-zinc-300">
        <button
          onClick={onHomeClick}
          className="flex items-center justify-center w-10 h-9 hover:bg-zinc-200 transition-colors border-r border-zinc-300"
          title="Home"
        >
          <Home className="w-4 h-4 text-zinc-600" />
        </button>

        <Tab label="File" active={activeTab === 'file'} onClick={() => setActiveTab('file')} />
        <Tab label={mainLabel} active={activeTab === 'main'} onClick={() => setActiveTab('main')} />
        <Tab label="View" active={activeTab === 'view'} onClick={() => setActiveTab('view')} />
      </div>

      {/* ── Toolbar content for active tab ────────────────────────────── */}
      <div className="flex items-center px-2 py-2 bg-zinc-50 border-b border-zinc-300 min-h-[4.5rem]">
        {activeTab === 'file' && fileActions && (
          <FileToolbar documentName={documentName} actions={fileActions} />
        )}
        {activeTab === 'main'
          ? (isSketch ? <SketchTools /> : <PartTools />)
          : activeTab === 'view'
          ? <ViewTools />
          : null}
      </div>
    </div>
  );
};

// ─── Tab button ──────────────────────────────────────────────────────────────
const Tab: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    onClick={onClick}
    className={`relative px-5 h-9 text-sm font-medium transition-colors ${
      active
        ? 'text-zinc-900 bg-white'
        : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/70'
    }`}
  >
    {label}
    {active && (
      <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-500" />
    )}
  </button>
);
