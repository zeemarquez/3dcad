import React, { useState, useRef, useEffect } from 'react';
import { useCadStore } from '../store/useCadStore';
import { FileEdit, Eye, EyeOff } from 'lucide-react';
import { VersionControl } from './VersionControl';

interface ContextMenuState {
  featureId: string;
  x: number;
  y: number;
}

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

export const FeatureTree = () => {
  const {
    features,
    solidResults,
    selectedFeatureId,
    setSelectedFeatureId,
    enterSketchMode,
    activeModule,
    deleteFeature,
    renameFeature,
    toggleFeatureEnabled,
    hiddenGeometryIds,
    toggleGeometryVisibility,
  } = useCadStore();

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [activeTab, setActiveTab] = useState<'features' | 'geometry'>('features');
  const [selectedGeometryId, setSelectedGeometryId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setRenamingId(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  // Early return AFTER all hooks
  if (activeModule === 'sketch') return null;

  const handleDoubleClick = (featureId: string) => {
    const feature = features.find((f) => f.id === featureId);
    if (feature?.type === 'sketch') {
      enterSketchMode(feature.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, featureId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedFeatureId(featureId);
    setContextMenu({ featureId, x: e.clientX, y: e.clientY });
  };

  const handleDelete = () => {
    if (!contextMenu) return;
    deleteFeature(contextMenu.featureId);
    setContextMenu(null);
  };

  const handleStartRename = () => {
    if (!contextMenu) return;
    const feature = features.find((f) => f.id === contextMenu.featureId);
    if (feature) {
      setRenamingId(feature.id);
      setRenameValue(feature.name);
    }
    setContextMenu(null);
  };

  const handleFinishRename = () => {
    if (renamingId && renameValue.trim()) {
      renameFeature(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const handleEditSketch = () => {
    if (!contextMenu) return;
    enterSketchMode(contextMenu.featureId);
    setContextMenu(null);
  };

  const handleToggleEnabled = () => {
    if (!contextMenu) return;
    toggleFeatureEnabled(contextMenu.featureId);
    setContextMenu(null);
  };

  const featureIcon = (type: string) => {
    switch (type) {
      case 'sketch':
      case 'extrude':
      case 'plane':
      case 'point':
      case 'axis':
      case 'cut':
      case 'revolve':
      case 'revolveCut':
      case 'fillet':
      case 'chamfer':
        return <img src={partIcons[type]} alt={type} className="w-6 h-6 mr-3 flex-shrink-0 object-contain" />;
      default:        return null;
    }
  };

  const contextFeature = contextMenu
    ? features.find((f) => f.id === contextMenu.featureId)
    : null;

  const originPlaneResults = [
    { id: 'origin-xy', name: 'XY Plane', type: 'plane', selectId: null },
    { id: 'origin-xz', name: 'XZ Plane', type: 'plane', selectId: null },
    { id: 'origin-yz', name: 'YZ Plane', type: 'plane', selectId: null },
  ];
  const constructionFeatureResults = features.filter((feature) =>
    ['plane', 'point', 'axis', 'sketch'].includes(feature.type)
  );
  const constructionResults = [...originPlaneResults, ...constructionFeatureResults];
  const solidsGeometryResults = solidResults.map((solid, index) => {
    return {
      id: solid.geometryId,
      name: `Solid ${index + 1}`,
      type: 'solid',
    };
  });

  return (
    <div className="w-64 h-full bg-zinc-50 border-r border-zinc-300 flex flex-col">
      <div className="flex items-center bg-zinc-100 border-b border-zinc-300">
        <button
          onClick={() => setActiveTab('features')}
          className={`relative flex-1 h-9 text-sm font-medium transition-colors ${
            activeTab === 'features'
              ? 'text-zinc-900 bg-white'
              : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/70'
          }`}
        >
          Features
          {activeTab === 'features' && (
            <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-500" />
          )}
        </button>
        <button
          onClick={() => setActiveTab('geometry')}
          className={`relative flex-1 h-9 text-sm font-medium transition-colors ${
            activeTab === 'geometry'
              ? 'text-zinc-900 bg-white'
              : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/70'
          }`}
        >
          Geometry
          {activeTab === 'geometry' && (
            <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-500" />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {activeTab === 'features' ? (
          <ul className="space-y-1">
            {features.map((feature) => (
              <li key={feature.id}>
                {renamingId === feature.id ? (
                  <div className="flex items-center px-3 py-1.5 bg-zinc-100 rounded-md">
                    {featureIcon(feature.type)}
                    <input
                      ref={renameRef}
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={handleFinishRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleFinishRename();
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="flex-1 bg-white border border-blue-500 rounded px-2 py-0.5 text-sm text-zinc-900 focus:outline-none"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setSelectedFeatureId(feature.id)}
                    onDoubleClick={() => handleDoubleClick(feature.id)}
                    onContextMenu={(e) => handleContextMenu(e, feature.id)}
                    className={`w-full flex items-center px-3 py-2 rounded-md text-sm transition-colors ${
                      selectedFeatureId === feature.id
                        ? 'bg-blue-600 text-white'
                        : feature.enabled === false
                        ? 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-500'
                        : 'text-zinc-700 hover:bg-zinc-200 hover:text-zinc-900'
                    }`}
                  >
                    {featureIcon(feature.type)}
                    <span className="flex-1 text-left truncate">{feature.name}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : activeTab === 'geometry' ? (
          <div className="space-y-4">
            <ResultGroup
              title="Construction"
              features={constructionResults}
              selectedGeometryId={selectedGeometryId}
              onSelect={setSelectedGeometryId}
              onClearFeatureSelection={() => setSelectedFeatureId(null)}
              featureIcon={featureIcon}
              hiddenGeometryIds={hiddenGeometryIds}
              onToggleVisibility={toggleGeometryVisibility}
            />
            <ResultGroup
              title="Solids"
              features={solidsGeometryResults}
              selectedGeometryId={selectedGeometryId}
              onSelect={setSelectedGeometryId}
              onClearFeatureSelection={() => setSelectedFeatureId(null)}
              featureIcon={featureIcon}
              hiddenGeometryIds={hiddenGeometryIds}
              onToggleVisibility={toggleGeometryVisibility}
            />
          </div>
        ) : null}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] bg-white border border-zinc-300 rounded-lg shadow-2xl py-1 overflow-hidden"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {contextFeature?.type === 'sketch' && (
            <button
              onClick={handleEditSketch}
              className="w-full text-left px-4 py-2 text-sm text-zinc-800 hover:bg-blue-600 hover:text-white transition-colors flex items-center gap-2"
            >
              <FileEdit className="w-3.5 h-3.5" />
              Edit Sketch
            </button>
          )}
          <button
            onClick={handleToggleEnabled}
            className="w-full text-left px-4 py-2 text-sm text-zinc-800 hover:bg-blue-600 hover:text-white transition-colors"
          >
            {contextFeature?.enabled === false ? 'Enable' : 'Disable'}
          </button>
          <button
            onClick={handleStartRename}
            className="w-full text-left px-4 py-2 text-sm text-zinc-800 hover:bg-blue-600 hover:text-white transition-colors"
          >
            Rename
          </button>
          <div className="border-t border-zinc-300 my-1" />
          <button
            onClick={handleDelete}
            className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-600 hover:text-white transition-colors"
          >
            Delete
          </button>
        </div>
      )}

      <VersionControl />
    </div>
  );
};

const ResultGroup = ({
  title,
  features,
  selectedGeometryId,
  onSelect,
  onClearFeatureSelection,
  featureIcon,
  hiddenGeometryIds,
  onToggleVisibility,
}: {
  title: string;
  features: Array<{ id: string; name: string; type: string }>;
  selectedGeometryId: string | null;
  onSelect: (id: string) => void;
  onClearFeatureSelection: () => void;
  featureIcon: (type: string) => React.ReactNode;
  hiddenGeometryIds: string[];
  onToggleVisibility: (id: string) => void;
}) => {
  return (
    <div>
      <h3 className="px-2 mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {features.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-400">No results yet</p>
      ) : (
        <ul className="space-y-1">
          {features.map((feature) => (
            <li key={feature.id}>
              <div
                onClick={() => {
                  onClearFeatureSelection();
                  onSelect(feature.id);
                }}
                className={`w-full flex items-center px-3 py-2 rounded-md text-sm transition-colors ${
                  selectedGeometryId === feature.id
                    ? 'bg-blue-600 text-white'
                    : 'text-zinc-700 hover:bg-zinc-200 hover:text-zinc-900'
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisibility(feature.id);
                  }}
                  className="mr-2 text-zinc-500 hover:text-zinc-800 transition-colors"
                  title={hiddenGeometryIds.includes(feature.id) ? 'Show' : 'Hide'}
                >
                  {hiddenGeometryIds.includes(feature.id) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                {featureIcon(feature.type)}
                <span className="flex-1 text-left truncate">{feature.name}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
