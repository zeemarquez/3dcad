import React from 'react';
import { CopyPlus, Download, FilePenLine, Save } from 'lucide-react';
import { ToolBtn } from '@/modules/part/toolbar/ToolBtn';

export interface DrawingFileToolbarActions {
  onRenameDocument: () => void;
  onSaveAs: () => void;
  onDownload: () => void;
  onCreateCopy: () => void;
}

export const DrawingFileToolbar: React.FC<{
  actions: DrawingFileToolbarActions;
}> = ({ actions }) => {
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      <ToolBtn
        icon={FilePenLine}
        label="Rename"
        showLabel={false}
        title="Rename document"
        onClick={actions.onRenameDocument}
      />
      <ToolBtn icon={Save} label="Save As" showLabel={false} title="Save As..." onClick={actions.onSaveAs} />
      <ToolBtn
        icon={Download}
        label="Download"
        showLabel={false}
        title="Download (PDF, DWG, or SVG)"
        onClick={actions.onDownload}
      />
      <ToolBtn icon={CopyPlus} label="Copy" showLabel={false} title="Create copy" onClick={actions.onCreateCopy} />
    </div>
  );
};
