import { useEffect, useMemo, useRef, useState } from 'react';
import { FeatureTree } from '@/modules/part/components/FeatureTree';
import { PropertyManager } from '@/modules/part/components/PropertyManager';
import { Viewport3D } from '@/modules/part/components/Viewport3D';
import { Sketcher2D } from '@/modules/part/sketch/Sketcher2D';
import { TopBar } from '@/modules/part/toolbar/TopBar';
import { ParametersDialog } from '@/modules/part/components/ParametersDialog';
import { DrawingEditor } from '@/modules/drawing/components/DrawingEditor';
import type { DrawingExportFormat } from '@/modules/drawing/components/DrawingDownloadFormatDialog';
import { HomePage } from './HomePage';
import {
  createDrawingDocumentMeta,
  createPartDocumentMeta,
  getLastOpenedDocumentId,
  listRecentDocuments,
  loadDrawingDocument,
  loadPartDocument,
  saveDrawingDocument,
  savePartDocument,
  setLastOpenedDocumentId,
  type RecentDocumentEntry,
} from './documentStore';
import { useCadStore, type MeshData, type PartDocumentMeta } from '@/modules/part/store/useCadStore';
import { useDrawingStore, type DrawingDocumentMeta } from '@/modules/drawing/store/useDrawingStore';

function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex -- intentional \u0000-\u001F class
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ') || 'Untitled Part';
}

function sanitizeDrawingName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ') || 'Untitled Drawing';
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
  const [view, setView] = useState<'home' | 'part' | 'drawing'>('home');
  const [recents, setRecents] = useState<RecentDocumentEntry[]>([]);
  const [activePartMeta, setActivePartMeta] = useState<PartDocumentMeta | null>(null);
  const [activeDrawingMeta, setActiveDrawingMeta] = useState<DrawingDocumentMeta | null>(null);
  const initializedRef = useRef(false);

  const features = useCadStore((s) => s.features);
  const userParameters = useCadStore((s) => s.userParameters);
  const dimensionParameters = useCadStore((s) => s.dimensionParameters);
  const exportPartDocumentData = useCadStore((s) => s.exportPartDocumentData);
  const importPartDocumentData = useCadStore((s) => s.importPartDocumentData);
  const resetDocument = useCadStore((s) => s.resetDocument);
  const meshes = useCadStore((s) => s.meshes);

  const exportDrawingDocumentData = useDrawingStore((s) => s.exportDrawingDocumentData);
  const importDrawingDocumentData = useDrawingStore((s) => s.importDrawingDocumentData);
  const resetDrawing = useDrawingStore((s) => s.resetDrawing);
  const drawingLinkedPartId = useDrawingStore((s) => s.linkedPartId);
  const drawingViews = useDrawingStore((s) => s.views);
  const drawingSheet = useDrawingStore((s) => s.sheet);

  const editorSnapshot = useMemo(
    () => ({ features, userParameters, dimensionParameters }),
    [features, userParameters, dimensionParameters],
  );

  const drawingSnapshot = useMemo(
    () => ({ linkedPartId: drawingLinkedPartId, views: drawingViews, sheet: drawingSheet }),
    [drawingLinkedPartId, drawingViews, drawingSheet],
  );

  const refreshRecents = () => setRecents(listRecentDocuments());

  const persistPartDocument = (
    meta: PartDocumentMeta,
    opts?: { touchTimestamp?: boolean; updateUiState?: boolean },
  ) => {
    const touchTimestamp = opts?.touchTimestamp ?? true;
    const updateUiState = opts?.updateUiState ?? true;
    const nextMeta = touchTimestamp ? { ...meta, updatedAt: Date.now() } : meta;
    const payload = exportPartDocumentData(nextMeta);
    savePartDocument(payload);
    setLastOpenedDocumentId(nextMeta.id, 'part');
    if (updateUiState) {
      setActivePartMeta(nextMeta);
      refreshRecents();
    }
  };

  const persistDrawingDocument = (
    meta: DrawingDocumentMeta,
    opts?: { touchTimestamp?: boolean; updateUiState?: boolean },
  ) => {
    const touchTimestamp = opts?.touchTimestamp ?? true;
    const updateUiState = opts?.updateUiState ?? true;
    const nextMeta = touchTimestamp ? { ...meta, updatedAt: Date.now() } : meta;
    const payload = exportDrawingDocumentData(nextMeta);
    saveDrawingDocument(payload);
    setLastOpenedDocumentId(nextMeta.id, 'drawing');
    if (updateUiState) {
      setActiveDrawingMeta(nextMeta);
      refreshRecents();
    }
  };

  const handleCreatePart = () => {
    const meta = createPartDocumentMeta();
    resetDocument();
    const payload = exportPartDocumentData(meta);
    savePartDocument(payload);
    setLastOpenedDocumentId(meta.id, 'part');
    setActivePartMeta(meta);
    setActiveDrawingMeta(null);
    refreshRecents();
    setView('part');
  };

  const handleCreateDrawing = () => {
    resetDrawing();
    const meta = createDrawingDocumentMeta();
    const payload = exportDrawingDocumentData(meta);
    saveDrawingDocument(payload);
    setLastOpenedDocumentId(meta.id, 'drawing');
    setActiveDrawingMeta(meta);
    setActivePartMeta(null);
    refreshRecents();
    setView('drawing');
  };

  const handleOpenDocument = (id: string, type: 'part' | 'drawing') => {
    if (type === 'drawing') {
      const doc = loadDrawingDocument(id);
      if (!doc) return;
      importDrawingDocumentData(doc);
      setActiveDrawingMeta(doc.meta);
      setActivePartMeta(null);
      setLastOpenedDocumentId(doc.meta.id, 'drawing');
      refreshRecents();
      setView('drawing');
      return;
    }
    const doc = loadPartDocument(id);
    if (!doc) return;
    importPartDocumentData(doc);
    setActivePartMeta(doc.meta);
    setActiveDrawingMeta(null);
    setLastOpenedDocumentId(doc.meta.id, 'part');
    refreshRecents();
    setView('part');
  };

  const handleGoHome = () => {
    if (view === 'part' && activePartMeta) {
      persistPartDocument(activePartMeta);
    }
    if (view === 'drawing' && activeDrawingMeta) {
      persistDrawingDocument(activeDrawingMeta);
    }
    setView('home');
    refreshRecents();
  };

  const handleRenamePart = () => {
    if (!activePartMeta) return;
    const next = window.prompt('Rename document', activePartMeta.name);
    if (!next) return;
    const nextName = sanitizeName(next);
    const nextMeta = { ...activePartMeta, name: nextName };
    persistPartDocument(nextMeta);
  };

  const handleSaveAsPart = () => {
    if (!activePartMeta) return;
    const next = window.prompt('Save As name', `${activePartMeta.name} Copy`);
    if (!next) return;
    const nextName = sanitizeName(next);
    const meta = createPartDocumentMeta(nextName);
    const payload = exportPartDocumentData(meta);
    savePartDocument(payload);
    setLastOpenedDocumentId(meta.id, 'part');
    setActivePartMeta(meta);
    refreshRecents();
  };

  const handleCreateCopyPart = () => {
    if (!activePartMeta) return;
    const meta = createPartDocumentMeta(`${activePartMeta.name} Copy`);
    const payload = exportPartDocumentData(meta);
    savePartDocument(payload);
    setLastOpenedDocumentId(meta.id, 'part');
    setActivePartMeta(meta);
    refreshRecents();
  };

  const handleDownloadPar = () => {
    if (!activePartMeta) return;
    const payload = exportPartDocumentData(activePartMeta);
    const fileName = `${sanitizeName(activePartMeta.name)}.par`;
    downloadBlob(JSON.stringify(payload, null, 2), fileName, 'application/json');
  };

  const handleRenameDrawing = () => {
    if (!activeDrawingMeta) return;
    const next = window.prompt('Rename document', activeDrawingMeta.name);
    if (!next) return;
    const nextName = sanitizeDrawingName(next);
    const nextMeta = { ...activeDrawingMeta, name: nextName };
    persistDrawingDocument(nextMeta);
  };

  const handleSaveAsDrawing = () => {
    if (!activeDrawingMeta) return;
    const next = window.prompt('Save As name', `${activeDrawingMeta.name} Copy`);
    if (!next) return;
    const nextName = sanitizeDrawingName(next);
    const meta = createDrawingDocumentMeta(nextName);
    const payload = exportDrawingDocumentData(meta);
    saveDrawingDocument(payload);
    setLastOpenedDocumentId(meta.id, 'drawing');
    setActiveDrawingMeta(meta);
    refreshRecents();
  };

  const handleCreateCopyDrawing = () => {
    if (!activeDrawingMeta) return;
    const meta = createDrawingDocumentMeta(`${activeDrawingMeta.name} Copy`);
    const payload = exportDrawingDocumentData(meta);
    saveDrawingDocument(payload);
    setLastOpenedDocumentId(meta.id, 'drawing');
    setActiveDrawingMeta(meta);
    refreshRecents();
  };

  const handleExportDrawing = (format: DrawingExportFormat) => {
    if (!activeDrawingMeta) return;
    if (format === 'pdf') return;

    const base = sanitizeDrawingName(activeDrawingMeta.name);
    const payload = exportDrawingDocumentData(activeDrawingMeta);
    const json = JSON.stringify(payload, null, 2);

    if (format === 'dwg') {
      const content = [
        'ModernCAD DWG export (placeholder — full binary DWG not implemented yet).',
        'Embedded drawing document (.drw JSON) follows.',
        '---BEGIN_JSON---',
        json,
        '---END_JSON---',
      ].join('\n');
      downloadBlob(content, `${base}.dwg`, 'application/acad');
      return;
    }

    const w = payload.sheet.widthMm;
    const h = payload.sheet.heightMm;
    const safeJson = json.replace(/\]\]>/g, '] ]>');
    const svg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
      `  <title>${base.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>`,
      '  <rect width="100%" height="100%" fill="#ffffff" stroke="#a1a1aa" stroke-width="0.25"/>',
      `  <text x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="4" fill="#71717a">SVG vector export preview</text>`,
      '  <metadata><![CDATA[',
      safeJson,
      '  ]]></metadata>',
      '</svg>',
    ].join('\n');
    downloadBlob(svg, `${base}.svg`, 'image/svg+xml');
  };

  const handleExportStl = () => {
    if (!activePartMeta) return;
    if (!meshes.length) {
      window.alert('No geometry to export.');
      return;
    }
    const stl = meshToAsciiStl(meshes, sanitizeName(activePartMeta.name));
    downloadBlob(stl, `${sanitizeName(activePartMeta.name)}.stl`, 'model/stl');
  };

  const handleExportStep = () => {
    if (!activePartMeta) return;
    const payload = exportPartDocumentData(activePartMeta);
    const content = [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION(('ModernCAD placeholder STEP export'),'2;1');`,
      `FILE_NAME('${sanitizeName(activePartMeta.name)}.step','${new Date().toISOString()}',('ModernCAD'),('ModernCAD'),'','', '');`,
      'ENDSEC;',
      'DATA;',
      `/* STEP kernel export pending. Embedded .par payload follows.\n${JSON.stringify(payload)}\n*/`,
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');
    downloadBlob(content, `${sanitizeName(activePartMeta.name)}.step`, 'application/step');
  };

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time mount: refresh recents and restore last-opened doc */
    if (initializedRef.current) return;
    initializedRef.current = true;
    refreshRecents();
    const lastOpened = getLastOpenedDocumentId();
    if (!lastOpened) return;
    if (lastOpened.kind === 'drawing') {
      const d = loadDrawingDocument(lastOpened.id);
      if (!d) return;
      importDrawingDocumentData(d);
      setActiveDrawingMeta(d.meta);
      setActivePartMeta(null);
      setView('drawing');
      return;
    }
    const lastDoc = loadPartDocument(lastOpened.id);
    if (!lastDoc) return;
    importPartDocumentData(lastDoc);
    setActivePartMeta(lastDoc.meta);
    setActiveDrawingMeta(null);
    setView('part');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [importPartDocumentData, importDrawingDocumentData]);

  useEffect(() => {
    if (view !== 'part' || !activePartMeta) return;
    const timer = window.setTimeout(() => {
      persistPartDocument(activePartMeta);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [view, activePartMeta, editorSnapshot]);

  useEffect(() => {
    if (view !== 'drawing' || !activeDrawingMeta) return;
    const timer = window.setTimeout(() => {
      persistDrawingDocument(activeDrawingMeta);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [view, activeDrawingMeta, drawingSnapshot]);

  useEffect(() => {
    if (view !== 'part' || !activePartMeta) return;
    const flush = () => persistPartDocument(activePartMeta, { touchTimestamp: true, updateUiState: false });
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [view, activePartMeta, editorSnapshot]);

  useEffect(() => {
    if (view !== 'drawing' || !activeDrawingMeta) return;
    const flush = () =>
      persistDrawingDocument(activeDrawingMeta, { touchTimestamp: true, updateUiState: false });
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [view, activeDrawingMeta, drawingSnapshot]);

  if (view === 'home') {
    return (
      <HomePage
        recents={recents}
        onCreatePart={handleCreatePart}
        onCreateDrawing={handleCreateDrawing}
        onOpenDocument={handleOpenDocument}
      />
    );
  }

  if (view === 'drawing') {
    return (
      <DrawingEditor
        documentBaseName={activeDrawingMeta ? sanitizeDrawingName(activeDrawingMeta.name) : 'Drawing'}
        onHome={handleGoHome}
        fileActions={{
          onRenameDocument: handleRenameDrawing,
          onSaveAs: handleSaveAsDrawing,
          onExportDrawing: handleExportDrawing,
          onCreateCopy: handleCreateCopyDrawing,
        }}
      />
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-100 text-zinc-900 font-sans">
      <TopBar
        onHomeClick={handleGoHome}
        documentName={activePartMeta?.name}
        fileActions={{
          onRenameDocument: handleRenamePart,
          onSaveAs: handleSaveAsPart,
          onDownloadPar: handleDownloadPar,
          onCreateCopy: handleCreateCopyPart,
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
