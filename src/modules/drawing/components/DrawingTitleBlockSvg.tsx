import type { ReactNode } from 'react';
import {
  TITLE_BLOCK_HEIGHT_MM,
  TITLE_BLOCK_WIDTH_MM,
  resolveTitleBlockText,
  type DrawingTitleBlockDocument,
  type TitleBlockAnchorCell,
} from '../titleBlock/titleBlockModel';

function cum0(arr: number[]): number[] {
  const o: number[] = [0];
  for (const x of arr) o.push(o[o.length - 1] + x);
  return o;
}

function CellText({
  cell,
  x,
  y,
  pxPerMm,
  resolved,
}: {
  cell: TitleBlockAnchorCell;
  x: number;
  y: number;
  pxPerMm: number;
  resolved: string;
}) {
  const pad = 1.2 * pxPerMm;
  const fs = Math.max(1.2, cell.format.fontSizeMm) * pxPerMm;
  const lines = resolved.split('\n');
  const weight = cell.format.bold ? 600 : 400;
  const fontStyle = cell.format.italic ? 'italic' : 'normal';
  const deco = cell.format.underline ? 'underline' : 'none';
  const lineGap = fs * 1.15;
  return (
    <text
      x={x + pad}
      y={y + pad}
      fill="#18181b"
      fontSize={fs}
      fontWeight={weight}
      fontStyle={fontStyle}
      textDecoration={deco}
      fontFamily="system-ui, Segoe UI, sans-serif"
      dominantBaseline="hanging"
    >
      {lines.map((line, i) => (
        <tspan key={i} x={x + pad} dy={i === 0 ? 0 : lineGap}>
          {line || ' '}
        </tspan>
      ))}
    </text>
  );
}

/**
 * Title block drawn in local coordinates (0,0)—(W,H) in px; parent positions on sheet.
 */
export function DrawingTitleBlockSvg({
  pxPerMm,
  doc,
  partName,
}: {
  pxPerMm: number;
  doc: DrawingTitleBlockDocument;
  partName?: string;
}) {
  const w = TITLE_BLOCK_WIDTH_MM * pxPerMm;
  const h = TITLE_BLOCK_HEIGHT_MM * pxPerMm;
  const { table, fieldValues } = doc;
  const stroke = '#27272a';
  const lineW = Math.max(0.65, 0.55 * pxPerMm);

  const cumRow = cum0(table.rowHeightsMm);
  const cumCol = cum0(table.colWidthsMm);
  const rows = table.rowHeightsMm.length;
  const cols = table.colWidthsMm.length;

  const els: ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = table.cells[r][c];
      if (!cell) continue;
      const x0 = cumCol[c] * pxPerMm;
      const y0 = cumRow[r] * pxPerMm;
      let cw = 0;
      for (let cc = c; cc < c + cell.colspan; cc++) cw += table.colWidthsMm[cc] ?? 0;
      let ch = 0;
      for (let rr = r; rr < r + cell.rowspan; rr++) ch += table.rowHeightsMm[rr] ?? 0;
      const cwPx = cw * pxPerMm;
      const chPx = ch * pxPerMm;
      const resolved = resolveTitleBlockText(cell.text, fieldValues, partName);
      els.push(
        <g key={`${r}-${c}`}>
          <rect
            x={x0}
            y={y0}
            width={cwPx}
            height={chPx}
            fill="#ffffff"
            stroke={stroke}
            strokeWidth={lineW}
          />
          <CellText
            cell={cell}
            x={x0}
            y={y0}
            pxPerMm={pxPerMm}
            resolved={resolved}
          />
        </g>,
      );
    }
  }

  return (
    <svg
      width={w}
      height={h}
      className="block select-none"
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
    >
      {els}
    </svg>
  );
}

export { TITLE_BLOCK_WIDTH_MM, TITLE_BLOCK_HEIGHT_MM };
