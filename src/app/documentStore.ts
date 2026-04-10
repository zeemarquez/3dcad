import type { PartDocumentData, PartDocumentMeta } from '@/modules/part/store/useCadStore';
import type { DrawingDocumentData, DrawingDocumentMeta } from '@/modules/drawing/store/useDrawingStore';

const STORAGE_KEYS = {
  index: 'moderncad.docs.index.v1',
  lastOpened: 'moderncad.docs.lastOpened.v1',
};

export interface RecentDocumentEntry {
  id: string;
  name: string;
  type: 'part' | 'drawing';
  extension: '.par' | '.drw';
  createdAt: number;
  updatedAt: number;
}

interface DocsIndex {
  version: 1;
  docs: RecentDocumentEntry[];
}

const emptyIndex = (): DocsIndex => ({ version: 1, docs: [] });

function getDocStorageKey(id: string): string {
  return `moderncad.doc.${id}.v1`;
}

function parseIndex(raw: string | null): DocsIndex {
  if (!raw) return emptyIndex();
  try {
    const parsed = JSON.parse(raw) as DocsIndex;
    if (!Array.isArray(parsed.docs)) return emptyIndex();
    const docs: RecentDocumentEntry[] = parsed.docs.map((d: RecentDocumentEntry) => ({
      ...d,
      type: d.type === 'drawing' ? 'drawing' : 'part',
      extension: d.extension === '.drw' ? '.drw' : '.par',
    }));
    return { version: 1, docs };
  } catch {
    return emptyIndex();
  }
}

function readIndex(): DocsIndex {
  return parseIndex(localStorage.getItem(STORAGE_KEYS.index));
}

function writeIndex(index: DocsIndex): void {
  localStorage.setItem(STORAGE_KEYS.index, JSON.stringify(index));
}

export function createPartDocumentMeta(name?: string): PartDocumentMeta {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: (name?.trim() || 'Untitled Part').replace(/\.par$/i, ''),
    extension: '.par',
    createdAt: now,
    updatedAt: now,
  };
}

export function createDrawingDocumentMeta(name?: string): DrawingDocumentMeta {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: (name?.trim() || 'Untitled Drawing').replace(/\.drw$/i, ''),
    extension: '.drw',
    createdAt: now,
    updatedAt: now,
  };
}

export function savePartDocument(doc: PartDocumentData): void {
  localStorage.setItem(getDocStorageKey(doc.meta.id), JSON.stringify(doc));
  const index = readIndex();
  const entry: RecentDocumentEntry = {
    id: doc.meta.id,
    name: doc.meta.name,
    type: 'part',
    extension: '.par',
    createdAt: doc.meta.createdAt,
    updatedAt: doc.meta.updatedAt,
  };
  const filtered = index.docs.filter((d) => d.id !== entry.id);
  writeIndex({
    version: 1,
    docs: [entry, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt),
  });
}

export function saveDrawingDocument(doc: DrawingDocumentData): void {
  localStorage.setItem(getDocStorageKey(doc.meta.id), JSON.stringify(doc));
  const index = readIndex();
  const entry: RecentDocumentEntry = {
    id: doc.meta.id,
    name: doc.meta.name,
    type: 'drawing',
    extension: '.drw',
    createdAt: doc.meta.createdAt,
    updatedAt: doc.meta.updatedAt,
  };
  const filtered = index.docs.filter((d) => d.id !== entry.id);
  writeIndex({
    version: 1,
    docs: [entry, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt),
  });
}

export function loadPartDocument(id: string): PartDocumentData | null {
  const raw = localStorage.getItem(getDocStorageKey(id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PartDocumentData;
    if (parsed?.kind !== 'part' || parsed?.version !== 1 || !parsed?.meta?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadDrawingDocument(id: string): DrawingDocumentData | null {
  const raw = localStorage.getItem(getDocStorageKey(id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DrawingDocumentData;
    if (parsed?.kind !== 'drawing' || parsed?.version !== 1 || !parsed?.meta?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listRecentDocuments(): RecentDocumentEntry[] {
  return readIndex().docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Part documents only (for linking from a drawing). */
export function listPartDocuments(): RecentDocumentEntry[] {
  return listRecentDocuments().filter((d) => d.type === 'part');
}

export function setLastOpenedDocumentId(id: string | null, kind: 'part' | 'drawing' = 'part'): void {
  if (!id) {
    localStorage.removeItem(STORAGE_KEYS.lastOpened);
    return;
  }
  localStorage.setItem(STORAGE_KEYS.lastOpened, `${kind}:${id}`);
}

export function getLastOpenedDocumentId(): { kind: 'part' | 'drawing'; id: string } | null {
  const raw = localStorage.getItem(STORAGE_KEYS.lastOpened);
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx > 0) {
    const kind = raw.slice(0, idx) as 'part' | 'drawing';
    const id = raw.slice(idx + 1);
    if (kind === 'part' || kind === 'drawing') return { kind, id };
  }
  return { kind: 'part', id: raw };
}
