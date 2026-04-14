/** Title block outer size on the A4 inner frame (mm). */
export const TITLE_BLOCK_WIDTH_MM = 88;
export const TITLE_BLOCK_HEIGHT_MM = 34;

/** Known {{placeholders}} resolved from field values + linked part name. */
export const TITLE_BLOCK_VARIABLE_KEYS = [
  'title',
  'drawingNumber',
  'scale',
  'revision',
  'date',
  'sheet',
  'company',
  'partName',
] as const;

export type TitleBlockVariableKey = (typeof TITLE_BLOCK_VARIABLE_KEYS)[number];

export interface TitleBlockCellFormat {
  /** Text cap height on paper (mm), typically 1.8–4. */
  fontSizeMm: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export interface TitleBlockAnchorCell {
  text: string;
  format: TitleBlockCellFormat;
  rowspan: number;
  colspan: number;
}

/** `null` = covered by a merged cell above/left. */
export type TitleBlockGridCell = TitleBlockAnchorCell | null;

export interface TitleBlockTableModel {
  rowHeightsMm: number[];
  colWidthsMm: number[];
  cells: TitleBlockGridCell[][];
}

export interface DrawingTitleBlockDocument {
  table: TitleBlockTableModel;
  /** Values for {{variable}} substitution in cell text. */
  fieldValues: Record<string, string>;
}

/** Legacy flat title block from older saves. */
export interface DrawingTitleBlockLegacy {
  title: string;
  drawingNumber: string;
  scale: string;
  revision: string;
  date: string;
  sheet: string;
  company: string;
}

export function defaultCellFormat(overrides?: Partial<TitleBlockCellFormat>): TitleBlockCellFormat {
  return {
    fontSizeMm: 2.1,
    bold: false,
    italic: false,
    underline: false,
    ...overrides,
  };
}

export function createDefaultTitleBlockDocument(): DrawingTitleBlockDocument {
  const rowHeightsMm = [10, 8, 8, 8];
  const colWidthsMm = [44, 44];
  const cells: TitleBlockGridCell[][] = [
    [
      {
        text: '{{title}}',
        format: defaultCellFormat({ fontSizeMm: 3 }),
        rowspan: 1,
        colspan: 2,
      },
      null,
    ],
    [
      { text: '{{drawingNumber}}', format: defaultCellFormat(), rowspan: 1, colspan: 1 },
      { text: '{{scale}}', format: defaultCellFormat(), rowspan: 1, colspan: 1 },
    ],
    [
      { text: '{{revision}}', format: defaultCellFormat(), rowspan: 1, colspan: 1 },
      { text: '{{date}}', format: defaultCellFormat(), rowspan: 1, colspan: 1 },
    ],
    [
      {
        text: '{{sheet}} · {{company}}',
        format: defaultCellFormat(),
        rowspan: 1,
        colspan: 2,
      },
      null,
    ],
  ];
  return {
    table: normalizeTableSizes({ rowHeightsMm, colWidthsMm, cells }),
    fieldValues: {
      title: 'Untitled drawing',
      drawingNumber: '—',
      scale: '—',
      revision: 'A',
      date: '',
      sheet: '1 / 1',
      company: '',
    },
  };
}

export function migrateLegacyTitleBlock(legacy: DrawingTitleBlockLegacy): DrawingTitleBlockDocument {
  const doc = createDefaultTitleBlockDocument();
  return {
    ...doc,
    fieldValues: {
      title: legacy.title,
      drawingNumber: legacy.drawingNumber,
      scale: legacy.scale,
      revision: legacy.revision,
      date: legacy.date,
      sheet: legacy.sheet,
      company: legacy.company,
    },
  };
}

/** Detect legacy flat object (has string `title` but no `table`). */
export function isLegacyTitleBlockShape(raw: unknown): raw is DrawingTitleBlockLegacy {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.title === 'string' && !('table' in o);
}

export function parseTitleBlockDocument(raw: unknown): DrawingTitleBlockDocument {
  if (!raw || typeof raw !== 'object') return createDefaultTitleBlockDocument();
  if (isLegacyTitleBlockShape(raw)) return migrateLegacyTitleBlock(raw);
  const o = raw as Partial<DrawingTitleBlockDocument>;
  if (o.table && o.fieldValues && Array.isArray((o.table as TitleBlockTableModel).cells)) {
    try {
      const table = JSON.parse(JSON.stringify(o.table)) as TitleBlockTableModel;
      return {
        table: normalizeTableSizes(table),
        fieldValues: { ...createDefaultTitleBlockDocument().fieldValues, ...(o.fieldValues as Record<string, string>) },
      };
    } catch {
      return createDefaultTitleBlockDocument();
    }
  }
  return createDefaultTitleBlockDocument();
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function resolveTitleBlockText(
  text: string,
  fieldValues: Record<string, string>,
  partName?: string,
): string {
  return text.replace(VAR_RE, (_, key: string) => {
    if (key === 'partName') return partName ?? '';
    return fieldValues[key] ?? '';
  });
}

export function normalizeTableSizes(table: TitleBlockTableModel): TitleBlockTableModel {
  const rows = table.rowHeightsMm.length;
  const cols = table.colWidthsMm.length;
  let rh = table.rowHeightsMm.map((h) => Math.max(2, h));
  let cw = table.colWidthsMm.map((w) => Math.max(4, w));
  const sumH = rh.reduce((a, b) => a + b, 0);
  const sumW = cw.reduce((a, b) => a + b, 0);
  if (sumH > 1e-6) rh = rh.map((h) => (h / sumH) * TITLE_BLOCK_HEIGHT_MM);
  if (sumW > 1e-6) cw = cw.map((w) => (w / sumW) * TITLE_BLOCK_WIDTH_MM);
  const cells = ensureGridShape(table.cells, rows, cols);
  return { rowHeightsMm: rh, colWidthsMm: cw, cells };
}

function ensureGridShape(cells: TitleBlockGridCell[][], rows: number, cols: number): TitleBlockGridCell[][] {
  const next: TitleBlockGridCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TitleBlockGridCell[] = [];
    for (let c = 0; c < cols; c++) {
      const v = cells[r]?.[c];
      if (v === undefined) {
        row.push({ text: '', format: defaultCellFormat(), rowspan: 1, colspan: 1 });
      } else {
        row.push(v);
      }
    }
    next.push(row);
  }
  return next;
}

export function getAnchorAt(
  table: TitleBlockTableModel,
  r: number,
  c: number,
): { r: number; c: number; cell: TitleBlockAnchorCell } | null {
  const rows = table.cells.length;
  const cols = table.cells[0]?.length ?? 0;
  if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
  const direct = table.cells[r][c];
  if (direct) return { r, c, cell: direct };
  for (let rr = 0; rr <= r; rr++) {
    for (let cc = 0; cc <= c; cc++) {
      const ac = table.cells[rr][cc];
      if (!ac) continue;
      const er = rr + ac.rowspan - 1;
      const ec = cc + ac.colspan - 1;
      if (r >= rr && r <= er && c >= cc && c <= ec) return { r: rr, c: cc, cell: ac };
    }
  }
  return null;
}

export type CellKey = `${number},${number}`;

export function keyRC(r: number, c: number): CellKey {
  return `${r},${c}`;
}

export function parseKey(k: CellKey): { r: number; c: number } {
  const [a, b] = k.split(',');
  return { r: Number(a), c: Number(b) };
}

/** Rectangle selection from drag: inclusive bounds in grid indices. */
export function cellsInRect(r0: number, c0: number, r1: number, c1: number): CellKey[] {
  const a = { r: Math.min(r0, r1), c: Math.min(c0, c1) };
  const b = { r: Math.max(r0, r1), c: Math.max(c0, c1) };
  const keys: CellKey[] = [];
  for (let r = a.r; r <= b.r; r++) {
    for (let c = a.c; c <= b.c; c++) keys.push(keyRC(r, c));
  }
  return keys;
}

/** Anchors in rect that are 1×1 only (for merge eligibility). */
export function rectIsAllOneByOneAnchors(
  table: TitleBlockTableModel,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): boolean {
  const a = { r: Math.min(r0, r1), c: Math.min(c0, c1) };
  const b = { r: Math.max(r0, r1), c: Math.max(c0, c1) };
  for (let r = a.r; r <= b.r; r++) {
    for (let c = a.c; c <= b.c; c++) {
      const cell = table.cells[r]?.[c];
      if (cell === null) return false;
      if (!cell) return false;
      if (cell.rowspan !== 1 || cell.colspan !== 1) return false;
    }
  }
  return true;
}

export function mergeCellsRect(
  table: TitleBlockTableModel,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): TitleBlockTableModel | null {
  if (!rectIsAllOneByOneAnchors(table, r0, c0, r1, c1)) return null;
  const a = { r: Math.min(r0, r1), c: Math.min(c0, c1) };
  const b = { r: Math.max(r0, r1), c: Math.max(c0, c1) };
  const rs = b.r - a.r + 1;
  const cs = b.c - a.c + 1;
  const cells = table.cells.map((row) => row.slice());
  const firstText = cells[a.r][a.c]!.text;
  const firstFmt = cells[a.r][a.c]!.format;
  for (let r = a.r; r <= b.r; r++) {
    for (let c = a.c; c <= b.c; c++) {
      if (r === a.r && c === a.c) {
        cells[r][c] = {
          text: firstText,
          format: { ...firstFmt },
          rowspan: rs,
          colspan: cs,
        };
      } else {
        cells[r][c] = null;
      }
    }
  }
  return { ...table, cells };
}

/** Append a new row at the bottom (keeps existing merges intact). */
export function addRow(table: TitleBlockTableModel): TitleBlockTableModel {
  const cols = table.colWidthsMm.length;
  const h = Math.max(4, TITLE_BLOCK_HEIGHT_MM / Math.max(4, table.rowHeightsMm.length + 1));
  const rowHeightsMm = [...table.rowHeightsMm, h];
  const cells = table.cells.map((row) => row.slice());
  cells.push(
    Array.from({ length: cols }, () => ({
      text: '',
      format: defaultCellFormat(),
      rowspan: 1,
      colspan: 1,
    })),
  );
  return normalizeTableSizes({ rowHeightsMm, colWidthsMm: table.colWidthsMm, cells });
}

/** Remove last row if it contains only plain 1×1 anchors (no null-covered cells). */
export function removeLastRow(table: TitleBlockTableModel): TitleBlockTableModel | null {
  if (table.rowHeightsMm.length <= 1) return null;
  const lastR = table.rowHeightsMm.length - 1;
  for (let c = 0; c < table.colWidthsMm.length; c++) {
    const cell = table.cells[lastR][c];
    if (cell === null) return null;
    if (cell.rowspan !== 1 || cell.colspan !== 1) return null;
  }
  const rowHeightsMm = table.rowHeightsMm.slice(0, -1);
  const cells = table.cells.slice(0, -1);
  return normalizeTableSizes({ rowHeightsMm, colWidthsMm: table.colWidthsMm, cells });
}

/** Append a new column on the right. */
export function addCol(table: TitleBlockTableModel): TitleBlockTableModel {
  const w = Math.max(6, TITLE_BLOCK_WIDTH_MM / Math.max(4, table.colWidthsMm.length + 1));
  const colWidthsMm = [...table.colWidthsMm, w];
  const cells = table.cells.map((row) => [
    ...row.slice(),
    { text: '', format: defaultCellFormat(), rowspan: 1, colspan: 1 },
  ]);
  return normalizeTableSizes({ rowHeightsMm: table.rowHeightsMm, colWidthsMm, cells });
}

/** Remove last column if it contains only plain 1×1 anchors. */
export function removeLastCol(table: TitleBlockTableModel): TitleBlockTableModel | null {
  if (table.colWidthsMm.length <= 1) return null;
  const lastC = table.colWidthsMm.length - 1;
  for (let r = 0; r < table.rowHeightsMm.length; r++) {
    const cell = table.cells[r][lastC];
    if (cell === null) return null;
    if (cell.rowspan !== 1 || cell.colspan !== 1) return null;
  }
  const colWidthsMm = table.colWidthsMm.slice(0, -1);
  const cells = table.cells.map((row) => row.slice(0, -1));
  return normalizeTableSizes({ rowHeightsMm: table.rowHeightsMm, colWidthsMm, cells });
}

export function updateCellAt(
  table: TitleBlockTableModel,
  anchorR: number,
  anchorC: number,
  patch: Partial<Pick<TitleBlockAnchorCell, 'text' | 'format' | 'rowspan' | 'colspan'>>,
): TitleBlockTableModel {
  const cells = table.cells.map((row) => row.slice());
  const cur = cells[anchorR][anchorC];
  if (!cur) return table;
  cells[anchorR][anchorC] = { ...cur, ...patch, format: patch.format ? { ...cur.format, ...patch.format } : cur.format };
  return { ...table, cells };
}

export function applyFormatToAnchors(
  table: TitleBlockTableModel,
  anchorKeys: CellKey[],
  formatPatch: Partial<TitleBlockCellFormat>,
): TitleBlockTableModel {
  const cells = table.cells.map((row) => row.slice());
  for (const k of anchorKeys) {
    const { r, c } = parseKey(k);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    cells[r][c] = {
      ...cell,
      format: { ...cell.format, ...formatPatch },
    };
  }
  return { ...table, cells };
}

export function redistributeColWidths(table: TitleBlockTableModel, i: number, deltaMm: number): TitleBlockTableModel {
  if (i < 1 || i >= table.colWidthsMm.length) return table;
  const cw = [...table.colWidthsMm];
  const a = i - 1;
  const b = i;
  const minW = 6;
  if (cw[a] + deltaMm < minW || cw[b] - deltaMm < minW) return table;
  cw[a] += deltaMm;
  cw[b] -= deltaMm;
  const sum = cw.reduce((x, y) => x + y, 0);
  const scale = TITLE_BLOCK_WIDTH_MM / sum;
  for (let j = 0; j < cw.length; j++) cw[j] *= scale;
  return normalizeTableSizes({ ...table, colWidthsMm: cw });
}

export function redistributeRowHeights(table: TitleBlockTableModel, i: number, deltaMm: number): TitleBlockTableModel {
  if (i < 1 || i >= table.rowHeightsMm.length) return table;
  const rh = [...table.rowHeightsMm];
  const a = i - 1;
  const b = i;
  const minH = 3;
  if (rh[a] + deltaMm < minH || rh[b] - deltaMm < minH) return table;
  rh[a] += deltaMm;
  rh[b] -= deltaMm;
  const sum = rh.reduce((x, y) => x + y, 0);
  const scale = TITLE_BLOCK_HEIGHT_MM / sum;
  for (let j = 0; j < rh.length; j++) rh[j] *= scale;
  return normalizeTableSizes({ ...table, rowHeightsMm: rh });
}
