import React from 'react';
import { FilePenLine, Save, Download, CopyPlus, Boxes, FileArchive } from 'lucide-react';
import { ToolBtn, Sep } from './ToolBtn';

export interface FileToolbarActions {
  onRenameDocument: () => void;
  onSaveAs: () => void;
  onDownloadPar: () => void;
  onCreateCopy: () => void;
  onExportStep: () => void;
  onExportStl: () => void;
}

export const FileToolbar: React.FC<{
  documentName?: string;
  actions: FileToolbarActions;
}> = ({ actions }) => {
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
