import React, { useState } from 'react';
import { Home } from 'lucide-react';
import { useCadStore } from '@/modules/part/store/useCadStore';
import { PartTools } from './PartTools';
import { SketchTools } from './SketchTools';
import { ViewTools } from './ViewTools';
import { FileToolbar, type FileToolbarActions } from './FileToolbar';

type RibbonTab = 'file' | 'main' | 'view';

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

export type { FileToolbarActions };

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
