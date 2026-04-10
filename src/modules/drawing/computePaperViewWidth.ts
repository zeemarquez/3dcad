import * as THREE from 'three';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';

function computeModelCentroid(solids: SolidMeshData[]): THREE.Vector3 {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let n = 0;
  for (const s of solids) {
    const p = s.vertices;
    for (let i = 0; i < p.length; i += 3) {
      sx += p[i];
      sy += p[i + 1];
      sz += p[i + 2];
      n++;
    }
  }
  return n ? new THREE.Vector3(sx / n, sy / n, sz / n) : new THREE.Vector3();
}

export interface PaperViewLayoutResult {
  /** On-paper size (mm) at drawing:model = num:den */
  widthMm: number;
  heightMm: number;
  /** Model bbox size in the view XY plane (mm), before scale — used for orthographic frustum */
  viewPlaneExtentXMm: number;
  viewPlaneExtentYMm: number;
}

/**
 * Paper size = model view-plane extent × (num/den). Both axes scaled equally when clamping to sheet.
 * Orthographic view must use viewPlaneExtentX/Y with fixed frustum (no viewport aspect padding).
 */
export function computePaperViewLayout(
  solids: SolidMeshData[],
  orientation: [number, number, number, number],
  scaleNum: number,
  scaleDen: number,
  opts?: { maxWidthMm?: number; maxHeightMm?: number },
): PaperViewLayoutResult {
  const q = new THREE.Quaternion(orientation[0], orientation[1], orientation[2], orientation[3]);
  const centroid = computeModelCentroid(solids);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();

  for (const s of solids) {
    const p = s.vertices;
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i] - centroid.x, p[i + 1] - centroid.y, p[i + 2] - centroid.z).applyQuaternion(q);
      box.expandByPoint(v);
    }
  }

  if (box.isEmpty()) {
    return {
      widthMm: 88,
      heightMm: 66,
      viewPlaneExtentXMm: 88,
      viewPlaneExtentYMm: 66,
    };
  }

  const extent = box.getSize(new THREE.Vector3());
  const viewPlaneExtentXMm = extent.x;
  const viewPlaneExtentYMm = extent.y;

  const num = Math.max(1, Math.round(scaleNum));
  const den = Math.max(1, Math.round(scaleDen));
  const ratio = num / den;

  let widthMm = viewPlaneExtentXMm * ratio;
  let heightMm = viewPlaneExtentYMm * ratio;

  const maxW = opts?.maxWidthMm;
  const maxH = opts?.maxHeightMm;
  let s = 1;
  if (maxW !== undefined && Number.isFinite(maxW) && widthMm > maxW) {
    s = Math.min(s, maxW / widthMm);
  }
  if (maxH !== undefined && Number.isFinite(maxH) && heightMm > maxH) {
    s = Math.min(s, maxH / heightMm);
  }
  widthMm *= s;
  heightMm *= s;

  widthMm = Math.max(widthMm, 12);
  heightMm = Math.max(heightMm, 12);

  return {
    widthMm,
    heightMm,
    viewPlaneExtentXMm,
    viewPlaneExtentYMm,
  };
}

/** @deprecated Use {@link computePaperViewLayout} */
export function computePaperViewWidthMm(
  solids: SolidMeshData[],
  orientation: [number, number, number, number],
  scaleNum: number,
  scaleDen: number,
  opts?: { maxWidthMm?: number },
): { widthMm: number; projectedModelWidthMm: number } {
  const lay = computePaperViewLayout(solids, orientation, scaleNum, scaleDen, {
    maxWidthMm: opts?.maxWidthMm,
  });
  return { widthMm: lay.widthMm, projectedModelWidthMm: lay.viewPlaneExtentXMm };
}
