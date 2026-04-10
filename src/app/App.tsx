import { useEffect, useMemo, useRef, useState } from 'react';
import { FeatureTree } from '@/modules/part/components/FeatureTree';
import { PropertyManager } from '@/modules/part/components/PropertyManager';
import { Viewport3D } from '@/modules/part/components/Viewport3D';
import { Sketcher2D } from '@/modules/part/sketch/Sketcher2D';
import { TopBar } from '@/modules/part/toolbar/TopBar';
import { ParametersDialog } from '@/modules/part/components/ParametersDialog';
import { HomePage } from './HomePage';
import {
  createPartDocumentMeta,
  getLastOpenedDocumentId,
  listRecentDocuments,
  loadPartDocument,
  savePartDocument,
  setLastOpenedDocumentId,
  type RecentDocumentEntry,
} from './documentStore';
import { useCadStore, type MeshData, type PartDocumentMeta } from '@/modules/part/store/useCadStore';

function sanitizeName(name: string): string {
  // Strip Windows-invalid filename characters (incl. control chars)
  // eslint-disable-next-line no-control-regex -- intentional \u0000-\u001F class
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ') || 'Untitled Part';
}

function downloadBlob(content: BlobPart, fileName: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function meshToAsciiStl(meshes: MeshData[], solidName: string): string {
  const lines: string[] = [`solid ${solidName}`];
  for (const mesh of meshes) {
    const p = mesh.positions;
    const n = mesh.normals;
    const idx = mesh.indices;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const i0 = idx[i] * 3;
      const i1 = idx[i + 1] * 3;
      const i2 = idx[i + 2] * 3;
      const nx = n[i0] ?? 0;
      const ny = n[i0 + 1] ?? 0;
      const nz = n[i0 + 2] ?? 1;
      lines.push(`  facet normal ${nx} ${ny} ${nz}`);
      lines.push('    outer loop');
      lines.push(`      vertex ${p[i0]} ${p[i0 + 1]} ${p[i0 + 2]}`);
      lines.push(`      vertex ${p[i1]} ${p[i1 + 1]} ${p[i1 + 2]}`);
      lines.push(`      vertex ${p[i2]} ${p[i2 + 1]} ${p[i2 + 2]}`);
      lines.push('    endloop');
      lines.push('  endfacet');
    }
  }
  lines.push(`endsolid ${solidName}`);
  return lines.join('\n');
}

function App() {
  const [view, setView] = useState<'home' | 'editor'>('home');
  const [recents, setRecents] = useState<RecentDocumentEntry[]>([]);
  const [activeDocMeta, setActiveDocMeta] = useState<PartDocumentMeta | null>(null);
  const initializedRef = useRef(false);

  const features = useCadStore((s) => s.features);
  const userParameters = useCadStore((s) => s.userParameters);
  const dimensionParameters = useCadStore((s) => s.dimensionParameters);
  const exportPartDocumentData = useCadStore((s) => s.exportPartDocumentData);
  const importPartDocumentData = useCadStore((s) => s.importPartDocumentData);
  const resetDocument = useCadStore((s) => s.resetDocument);
  const meshes = useCadStore((s) => s.meshes);

  const editorSnapshot = useMemo(
    () => ({ features, userParameters, dimensionParameters }),
    [features, userParameters, dimensionParameters]
  );

  const refreshRecents = () => setRecents(listRecentDocuments());

  const persistDocument = (
    meta: PartDocumentMeta,
    opts?: { touchTimestamp?: boolean; updateUiState?: boolean }
  ) => {
    const touchTimestamp = opts?.touchTimestamp ?? true;
    const updateUiState = opts?.updateUiState ?? true;
    const nextMeta = touchTimestamp ? { ...meta, updatedAt: Date.now() } : meta;
    const payload = exportPartDocumentData(nextMeta);
    savePartDocument(payload);
    setLastOpenedDocumentId(nextMeta.id);
    if (updateUiState) {
      setActiveDocMeta(nextMeta);
      refreshRecents();
    }
  };

  const handleCreatePart = () => {
    const meta = createPartDocumentMeta();
    resetDocument();
    const payload = exportPartDocumentData(meta);
    savePartDocument(payload);
    setLastOpenedDocumentId(meta.id);
    setActiveDocMeta(meta);
    refreshRecents();
    setView('editor');
  };

  const handleOpenDocument = (id: string) => {
    const doc = loadPartDocument(id);
    if (!doc) return;
    importPartDocumentData(doc);
    setActiveDocMeta(doc.meta);
    setLastOpenedDocumentId(doc.meta.id);
    refreshRecents();
    setView('editor');
  };

  const handleGoHome = () => {
    if (activeDocMeta) {
      persistDocument(activeDocMeta);
    }
    setView('home');
    refreshRecents();
  };

  const handleRenameDocument = () => {
    if (!activeDocMeta) return;
    const next = window.prompt('Rename document', activeDocMeta.name);
    if (!next) return;
    const nextName = sanitizeName(next);
    const nextMeta = { ...activeDocMeta, name: nextName };
    persistDocument(nextMeta);
  };

  const handleSaveAs = () => {
    if (!activeDocMeta) return;
    const next = window.prompt('Save As name', `${activeDocMeta.name} Copy`);
    if (!next) return;
    const nextName = sanitizeName(next);
    const meta = createPartDocumentMeta(nextName);
    const payload = exportPartDocumentData(meta);
    savePartDocument(payload);
    setLastOpenedDocumentId(meta.id);
    setActiveDocMeta(meta);
    refreshRecents();
  };

  const handleCreateCopy = () => {
    if (!activeDocMeta) return;
    const meta = createPartDocumentMeta(`${activeDocMeta.name} Copy`);
    const payload = exportPartDocumentData(meta);
    savePartDocument(payload);
    setLastOpenedDocumentId(meta.id);
    setActiveDocMeta(meta);
    refreshRecents();
  };

  const handleDownloadPar = () => {
    if (!activeDocMeta) return;
    const payload = exportPartDocumentData(activeDocMeta);
    const fileName = `${sanitizeName(activeDocMeta.name)}.par`;
    downloadBlob(JSON.stringify(payload, null, 2), fileName, 'application/json');
  };

  const handleExportStl = () => {
    if (!activeDocMeta) return;
    if (!meshes.length) {
      window.alert('No geometry to export.');
      return;
    }
    const stl = meshToAsciiStl(meshes, sanitizeName(activeDocMeta.name));
    downloadBlob(stl, `${sanitizeName(activeDocMeta.name)}.stl`, 'model/stl');
  };

  const handleExportStep = () => {
    if (!activeDocMeta) return;
    const payload = exportPartDocumentData(activeDocMeta);
    const content = [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION(('ModernCAD placeholder STEP export'),'2;1');`,
      `FILE_NAME('${sanitizeName(activeDocMeta.name)}.step','${new Date().toISOString()}',('ModernCAD'),('ModernCAD'),'','', '');`,
      'ENDSEC;',
      'DATA;',
      `/* STEP kernel export pending. Embedded .par payload follows.\n${JSON.stringify(payload)}\n*/`,
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');
    downloadBlob(content, `${sanitizeName(activeDocMeta.name)}.step`, 'application/step');
  };

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time mount: refresh recents and restore last-opened doc */
    if (initializedRef.current) return;
    initializedRef.current = true;
    refreshRecents();
    const lastOpenedId = getLastOpenedDocumentId();
    if (!lastOpenedId) return;
    const lastDoc = loadPartDocument(lastOpenedId);
    if (!lastDoc) return;
    importPartDocumentData(lastDoc);
    setActiveDocMeta(lastDoc.meta);
    setView('editor');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [importPartDocumentData]);

  useEffect(() => {
    if (view !== 'editor' || !activeDocMeta) return;
    const timer = window.setTimeout(() => {
      persistDocument(activeDocMeta);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [view, activeDocMeta, editorSnapshot]);

  useEffect(() => {
    if (view !== 'editor' || !activeDocMeta) return;
    const flush = () => persistDocument(activeDocMeta, { touchTimestamp: true, updateUiState: false });
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [view, activeDocMeta, editorSnapshot]);

  if (view === 'home') {
    return <HomePage recents={recents} onCreatePart={handleCreatePart} onOpenDocument={handleOpenDocument} />;
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-100 text-zinc-900 font-sans">
      <TopBar
        onHomeClick={handleGoHome}
        documentName={activeDocMeta?.name}
        fileActions={{
          onRenameDocument: handleRenameDocument,
          onSaveAs: handleSaveAs,
          onDownloadPar: handleDownloadPar,
          onCreateCopy: handleCreateCopy,
          onExportStep: handleExportStep,
          onExportStl: handleExportStl,
        }}
      />
      <div className="flex flex-1 overflow-hidden">
        <FeatureTree />
        <main className="flex-1 relative overflow-hidden">
          <Viewport3D />
          <Sketcher2D />
        </main>
        <PropertyManager />
      </div>
      <ParametersDialog />
    </div>
  );
}

export default App;
