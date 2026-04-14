import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

function removePdfExportGridFromClone(doc: Document): void {
  doc.querySelectorAll('.drawing-sheet-grid-layer').forEach((el) => el.remove());
  doc.querySelectorAll('#drawingGrid').forEach((el) => el.remove());
}

/**
 * Rasterizes the live drawing sheet DOM into a PDF at true sheet size (mm).
 * Grid is stripped in the clone so it does not appear in the export.
 */
export async function exportDrawingSheetToPdf(
  sheetElement: HTMLElement,
  fileBaseName: string,
  sheetSizeMm: { widthMm: number; heightMm: number },
): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });

  const wMm = sheetSizeMm.widthMm;
  const hMm = sheetSizeMm.heightMm;
  const wPx = Math.max(1, Math.round(sheetElement.offsetWidth));
  const hPx = Math.max(1, Math.round(sheetElement.offsetHeight));

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  /** html2canvas scale — higher effective print DPI (typ. ~250–350 DPI for A4 on-screen layout). */
  const scale = Math.min(6, Math.max(4, dpr * 2.5));

  const canvas = await html2canvas(sheetElement, {
    width: wPx,
    height: hPx,
    windowWidth: wPx,
    windowHeight: hPx,
    scale,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
    allowTaint: true,
    foreignObjectRendering: false,
    onclone: (clonedDoc) => {
      removePdfExportGridFromClone(clonedDoc);
    },
  });

  const isLandscape = wMm >= hMm;
  const pdf = new jsPDF(isLandscape ? 'l' : 'p', 'mm', [wMm, hMm], true);

  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  pdf.setFillColor(255, 255, 255);
  pdf.rect(0, 0, pageW, pageH, 'F');

  const imgData = canvas.toDataURL('image/png', 0.98);

  const cw = canvas.width;
  const ch = canvas.height;
  const pageAspect = pageW / pageH;
  const imgAspect = cw / ch;

  let drawW = pageW;
  let drawH = pageH;
  let x = 0;
  let y = 0;

  if (cw > 0 && ch > 0 && Math.abs(imgAspect - pageAspect) > 1e-4) {
    if (imgAspect > pageAspect) {
      drawW = pageW;
      drawH = pageW / imgAspect;
      y = (pageH - drawH) / 2;
    } else {
      drawH = pageH;
      drawW = pageH * imgAspect;
      x = (pageW - drawW) / 2;
    }
  }

  pdf.addImage(imgData, 'PNG', x, y, drawW, drawH);
  pdf.save(`${fileBaseName}.pdf`);
}
