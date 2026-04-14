import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  TITLE_BLOCK_HEIGHT_MM,
  TITLE_BLOCK_WIDTH_MM,
  TITLE_BLOCK_VARIABLE_KEYS,
  addCol,
  addRow,
  applyFormatToAnchors,
  defaultCellFormat,
  getAnchorAt,
  keyRC,
  mergeCellsRect,
  parseKey,
  redistributeColWidths,
  redistributeRowHeights,
  removeLastCol,
  removeLastRow,
  rectIsAllOneByOneAnchors,
  type CellKey,
  type DrawingTitleBlockDocument,
  type TitleBlockTableModel,
  updateCellAt,
} from '../titleBlock/titleBlockModel';
import { Bold, Italic, Merge, Minus, Plus, Underline } from 'lucide-react';

const EDITOR_PX_PER_MM = 3.25;

function cum0(arr: number[]): number[] {
  const o: number[] = [0];
  for (const x of arr) o.push(o[o.length - 1] + x);
  return o;
}

function anchorsInSelectionRect(
  table: TitleBlockTableModel,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): Set<CellKey> {
  const a = { r: Math.min(r0, r1), c: Math.min(c0, c1) };
  const b = { r: Math.max(r0, r1), c: Math.max(c0, c1) };
  const set = new Set<CellKey>();
  for (let r = a.r; r <= b.r; r++) {
    for (let c = a.c; c <= b.c; c++) {
      const g = getAnchorAt(table, r, c);
      if (g) set.add(keyRC(g.r, g.c));
    }
  }
  return set;
}

export function TitleBlockTableEditor({
  doc,
  setDoc,
}: {
  doc: DrawingTitleBlockDocument;
  setDoc: Dispatch<SetStateAction<DrawingTitleBlockDocument>>;
}) {
  const table = doc.table;
  const rows = table.rowHeightsMm.length;
  const cols = table.colWidthsMm.length;

  const gridW = TITLE_BLOCK_WIDTH_MM * EDITOR_PX_PER_MM;
  const gridH = TITLE_BLOCK_HEIGHT_MM * EDITOR_PX_PER_MM;

  const colTpl = table.colWidthsMm.map((w) => `${(w / TITLE_BLOCK_WIDTH_MM) * 100}%`).join(' ');
  const rowTpl = table.rowHeightsMm.map((h) => `${(h / TITLE_BLOCK_HEIGHT_MM) * 100}%`).join(' ');

  const [sel0, setSel0] = useState<{ r: number; c: number } | null>(null);
  const [sel1, setSel1] = useState<{ r: number; c: number } | null>(null);
  const [dragSel, setDragSel] = useState(false);
  const activeAnchorRef = useRef<{ r: number; c: number } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const selectionRect = useMemo(() => {
    if (!sel0 || !sel1) return null;
    return {
      r0: Math.min(sel0.r, sel1.r),
      c0: Math.min(sel0.c, sel1.c),
      r1: Math.max(sel0.r, sel1.r),
      c1: Math.max(sel0.c, sel1.c),
    };
  }, [sel0, sel1]);

  const selectedAnchors = useMemo(() => {
    if (!selectionRect) return new Set<CellKey>();
    return anchorsInSelectionRect(table, selectionRect.r0, selectionRect.c0, selectionRect.r1, selectionRect.c1);
  }, [table, selectionRect]);

  const primaryAnchor = useMemo(() => {
    if (selectedAnchors.size === 0) return null;
    const first = [...selectedAnchors][0];
    return parseKey(first);
  }, [selectedAnchors]);

  const singleAnchor = selectedAnchors.size === 1 ? primaryAnchor : null;
  const canMerge =
    selectionRect &&
    selectedAnchors.size > 1 &&
    rectIsAllOneByOneAnchors(
      table,
      selectionRect.r0,
      selectionRect.c0,
      selectionRect.r1,
      selectionRect.c1,
    );

  const firstCellFormat = useMemo(() => {
    if (!primaryAnchor) return defaultCellFormat();
    const cell = table.cells[primaryAnchor.r][primaryAnchor.c];
    return cell?.format ?? defaultCellFormat();
  }, [table, primaryAnchor]);

  const setTable = useCallback(
    (next: TitleBlockTableModel) => {
      setDoc((d) => ({ ...d, table: next }));
    },
    [setDoc],
  );

  const tableRef = useRef(table);
  tableRef.current = table;

  const onCellPointerDown = (e: React.PointerEvent, r: number, c: number) => {
    if ((e.target as HTMLElement).closest('[data-resize]')) return;
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    e.preventDefault();
    const g = getAnchorAt(table, r, c);
    if (!g) return;
    activeAnchorRef.current = { r: g.r, c: g.c };
    setSel0({ r: g.r, c: g.c });
    setSel1({ r: g.r, c: g.c });
    setDragSel(true);
  };

  useEffect(() => {
    if (!dragSel) return;
    const onMove = (e: PointerEvent) => {
      const el = gridRef.current;
      if (!el || !activeAnchorRef.current) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
      const t = tableRef.current;
      const cumCol = cum0(t.colWidthsMm).map((mm) => (mm / TITLE_BLOCK_WIDTH_MM) * gridW);
      const cumRow = cum0(t.rowHeightsMm).map((mm) => (mm / TITLE_BLOCK_HEIGHT_MM) * gridH);
      let c = 0;
      for (let i = 0; i < cumCol.length - 1; i++) {
        if (x >= cumCol[i] && x < cumCol[i + 1]) {
          c = i;
          break;
        }
      }
      let r = 0;
      for (let i = 0; i < cumRow.length - 1; i++) {
        if (y >= cumRow[i] && y < cumRow[i + 1]) {
          r = i;
          break;
        }
      }
      r = Math.max(0, Math.min(t.rowHeightsMm.length - 1, r));
      c = Math.max(0, Math.min(t.colWidthsMm.length - 1, c));
      setSel0(activeAnchorRef.current);
      setSel1({ r, c });
    };
    const onUp = () => {
      setDragSel(false);
      activeAnchorRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragSel, gridW, gridH]);

  const [fontSizeStr, setFontSizeStr] = useState(String(firstCellFormat.fontSizeMm));
  useEffect(() => {
    setFontSizeStr(String(firstCellFormat.fontSizeMm));
  }, [firstCellFormat.fontSizeMm]);

  const applyFontSize = () => {
    const n = parseFloat(fontSizeStr);
    if (!Number.isFinite(n) || n < 0.8 || n > 12) return;
    if (selectedAnchors.size === 0) return;
    const keys = [...selectedAnchors];
    setDoc((d) => ({
      ...d,
      table: applyFormatToAnchors(d.table, keys, { fontSizeMm: n }),
    }));
  };

  const toggleFmt = (key: 'bold' | 'italic' | 'underline') => {
    if (selectedAnchors.size === 0) return;
    const cur = firstCellFormat;
    const patch =
      key === 'bold'
        ? { bold: !cur.bold }
        : key === 'italic'
          ? { italic: !cur.italic }
          : { underline: !cur.underline };
    const keys = [...selectedAnchors];
    setDoc((d) => ({
      ...d,
      table: applyFormatToAnchors(d.table, keys, patch),
    }));
  };

  /** Insert variable into focused cell — uses single selection anchor */
  const insertVariable = (key: string) => {
    if (!singleAnchor) return;
    const { r, c } = singleAnchor;
    const ins = `{{${key}}}`;
    setDoc((d) => {
      const cell = d.table.cells[r][c];
      if (!cell) return d;
      return { ...d, table: updateCellAt(d.table, r, c, { text: cell.text + ins }) };
    });
  };

  const merge = () => {
    if (!selectionRect || !canMerge) return;
    const { r0, c0, r1, c1 } = selectionRect;
    setDoc((d) => {
      const m = mergeCellsRect(d.table, r0, c0, r1, c1);
      return m ? { ...d, table: m } : d;
    });
  };

  const colEdges = cum0(table.colWidthsMm).map((mm) => (mm / TITLE_BLOCK_WIDTH_MM) * gridW);
  const rowEdges = cum0(table.rowHeightsMm).map((mm) => (mm / TITLE_BLOCK_HEIGHT_MM) * gridH);

  const [colDrag, setColDrag] = useState<{ i: number; startX: number; startTable: TitleBlockTableModel } | null>(
    null,
  );
  const [rowDrag, setRowDrag] = useState<{ i: number; startY: number; startTable: TitleBlockTableModel } | null>(
    null,
  );

  useEffect(() => {
    if (!colDrag) return;
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - colDrag.startX;
      const dMm = dx / EDITOR_PX_PER_MM;
      const next = redistributeColWidths(colDrag.startTable, colDrag.i, dMm);
      setDoc((d) => ({ ...d, table: next }));
    };
    const onUp = () => setColDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [colDrag, setDoc]);

  useEffect(() => {
    if (!rowDrag) return;
    const onMove = (e: PointerEvent) => {
      const dy = e.clientY - rowDrag.startY;
      const dMm = dy / EDITOR_PX_PER_MM;
      const next = redistributeRowHeights(rowDrag.startTable, rowDrag.i, dMm);
      setDoc((d) => ({ ...d, table: next }));
    };
    const onUp = () => setRowDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [rowDrag, setDoc]);

  const anchors = useMemo(() => {
    const out: { r: number; c: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (table.cells[r][c]) out.push({ r, c });
      }
    }
    return out;
  }, [table, rows, cols]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-2">
        {singleAnchor && (
          <div className="flex flex-wrap items-center gap-2 border-r border-zinc-200 pr-2">
            <select
              className="max-w-[140px] rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900"
              title="Insert variable"
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) insertVariable(v);
                e.target.value = '';
              }}
            >
              <option value="">+ Variable</option>
              {TITLE_BLOCK_VARIABLE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {`{{${k}}}`}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-zinc-600">
              Size (mm)
              <input
                type="number"
                step={0.1}
                min={0.8}
                max={12}
                className="w-14 rounded border border-zinc-300 px-1 py-0.5 text-xs tabular-nums"
                value={fontSizeStr}
                onChange={(e) => setFontSizeStr(e.target.value)}
                onBlur={applyFontSize}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyFontSize();
                }}
              />
            </label>
            <button
              type="button"
              title="Bold"
              className={`rounded p-1.5 ${firstCellFormat.bold ? 'bg-zinc-300' : 'hover:bg-zinc-200'}`}
              onClick={() => toggleFmt('bold')}
            >
              <Bold className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Italic"
              className={`rounded p-1.5 ${firstCellFormat.italic ? 'bg-zinc-300' : 'hover:bg-zinc-200'}`}
              onClick={() => toggleFmt('italic')}
            >
              <Italic className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Underline"
              className={`rounded p-1.5 ${firstCellFormat.underline ? 'bg-zinc-300' : 'hover:bg-zinc-200'}`}
              onClick={() => toggleFmt('underline')}
            >
              <Underline className="h-4 w-4" />
            </button>
          </div>
        )}

        {canMerge && (
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium hover:bg-zinc-100"
            onClick={merge}
          >
            <Merge className="h-3.5 w-3.5" />
            Merge
          </button>
        )}

        <div className="flex flex-wrap items-center gap-1 border-l border-zinc-200 pl-2">
          <button
            type="button"
            className="flex items-center gap-0.5 rounded px-2 py-1 text-xs hover:bg-zinc-200"
            title="Add row at bottom"
            onClick={() => setTable(addRow(table))}
          >
            <Plus className="h-3.5 w-3.5" /> Row
          </button>
          <button
            type="button"
            className="flex items-center gap-0.5 rounded px-2 py-1 text-xs hover:bg-zinc-200"
            title="Add column on the right"
            onClick={() => setTable(addCol(table))}
          >
            <Plus className="h-3.5 w-3.5" /> Col
          </button>
          <button
            type="button"
            className="flex items-center gap-0.5 rounded px-2 py-1 text-xs hover:bg-zinc-200"
            title="Remove last row"
            onClick={() => {
              const n = removeLastRow(table);
              if (n) setTable(n);
            }}
          >
            <Minus className="h-3.5 w-3.5" /> Row
          </button>
          <button
            type="button"
            className="flex items-center gap-0.5 rounded px-2 py-1 text-xs hover:bg-zinc-200"
            title="Remove last column"
            onClick={() => {
              const n = removeLastCol(table);
              if (n) setTable(n);
            }}
          >
            <Minus className="h-3.5 w-3.5" /> Col
          </button>
        </div>
      </div>

      <div
        ref={gridRef}
        className="relative inline-block overflow-visible rounded border border-zinc-300 bg-white"
        style={{ width: gridW, height: gridH }}
      >
        <div
          className="grid h-full w-full"
          style={{
            gridTemplateColumns: colTpl,
            gridTemplateRows: rowTpl,
          }}
        >
          {anchors.map(({ r, c }) => {
            const cell = table.cells[r][c]!;
            const g = getAnchorAt(table, r, c)!;
            const k = keyRC(g.r, g.c);
            const sel = selectedAnchors.has(k);
            return (
              <div
                key={k}
                className={`box-border flex min-h-0 min-w-0 border border-zinc-400 ${sel ? 'bg-blue-100/90' : 'bg-white'}`}
                style={{
                  gridColumn: `${c + 1} / span ${cell.colspan}`,
                  gridRow: `${r + 1} / span ${cell.rowspan}`,
                }}
                onPointerDown={(e) => onCellPointerDown(e, r, c)}
              >
                <textarea
                  className="size-full min-h-0 resize-none bg-transparent p-1.5 text-[11px] text-zinc-900 outline-none"
                  style={{
                    fontWeight: cell.format.bold ? 600 : 400,
                    fontStyle: cell.format.italic ? 'italic' : 'normal',
                    textDecoration: cell.format.underline ? 'underline' : 'none',
                    fontSize: `${Math.max(9, cell.format.fontSizeMm * EDITOR_PX_PER_MM * 0.85)}px`,
                  }}
                  value={cell.text}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDoc((d) => ({ ...d, table: updateCellAt(d.table, r, c, { text: v }) }));
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              </div>
            );
          })}
        </div>

        {colEdges.slice(1, -1).map((leftPx, j) => (
          <div
            key={`col-${j}`}
            data-resize
            className="absolute top-0 z-20 w-3 cursor-col-resize hover:bg-blue-400/25"
            style={{
              left: leftPx - 6,
              height: gridH,
            }}
            title="Drag to resize columns"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setColDrag({ i: j + 1, startX: e.clientX, startTable: table });
            }}
          />
        ))}
        {rowEdges.slice(1, -1).map((topPx, j) => (
          <div
            key={`row-${j}`}
            data-resize
            className="absolute left-0 z-20 h-3 cursor-row-resize hover:bg-blue-400/25"
            style={{
              top: topPx - 6,
              width: gridW,
            }}
            title="Drag to resize rows"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setRowDrag({ i: j + 1, startY: e.clientY, startTable: table });
            }}
          />
        ))}
      </div>

      <p className="text-[11px] text-zinc-500">
        Drag across cells to select a range. Resize rows or columns by dragging the borders. Append/remove row or column
        from the end; merge requires a rectangle of single cells.
      </p>
    </div>
  );
}
