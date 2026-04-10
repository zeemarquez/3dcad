import type { PartDocumentData, PartDocumentMeta } from '@/modules/part/store/useCadStore';

const STORAGE_KEYS = {
  index: 'moderncad.docs.index.v1',
  lastOpened: 'moderncad.docs.lastOpened.v1',
};

export interface RecentDocumentEntry {
  id: string;
  name: string;
  type: 'part';
  extension: '.par';
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
    return { version: 1, docs: parsed.docs };
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

export function listRecentDocuments(): RecentDocumentEntry[] {
  return readIndex().docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function setLastOpenedDocumentId(id: string | null): void {
  if (!id) {
    localStorage.removeItem(STORAGE_KEYS.lastOpened);
    return;
  }
  localStorage.setItem(STORAGE_KEYS.lastOpened, id);
}

export function getLastOpenedDocumentId(): string | null {
  return localStorage.getItem(STORAGE_KEYS.lastOpened);
}
