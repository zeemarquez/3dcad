import { useLayoutEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { useDrawingStore } from '../store/useDrawingStore';
import type { DrawingDimensionMode, DrawingSheetDimension } from '../store/useDrawingStore';
import { DrawingOrthoDimensionLayer } from './DrawingOrthoDimensionLayer';

const MARGIN = 1.08;
/**
 * Sheet views use stored bbox half-extents; edge lines / AA can sit slightly outside that box.
 * Uniform scale on both axes keeps paper aspect correct (no stretch) while avoiding clip.
 */
const SHEET_EDGE_SLACK = 1.028;

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

/**
 * World +Z camera, XY view plane (same convention as part Front view), exact axis alignment.
 * Centers the model with t = −R·centroid so the camera never uses lookAt from an off-axis target
 * (which drei's Bounds did when the bbox center ≠ origin).
 */
function OrthoAxisAlignedFit({
  solids,
  q,
  fixedHalfExtentsMm,
  centroid,
  canvasGutterPx = 0,
  children,
}: {
  solids: SolidMeshData[];
  q: THREE.Quaternion;
  /** When set (sheet view), ortho uses stored half-extents with uniform edge slack (see SHEET_EDGE_SLACK). */
  fixedHalfExtentsMm?: { x: number; y: number } | null;
  centroid: THREE.Vector3;
  /**
   * When the canvas is larger than the letterboxed model area (sheet views), expand the ortho
   * frustum so the model keeps the same on-screen scale in the center while dimensions can draw
   * into the gutter pixels without clipping.
   */
  canvasGutterPx?: number;
  children: React.ReactNode;
}) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const size = useThree((s) => s.size);

  const offset = useMemo(
    () => new THREE.Vector3().copy(centroid).applyQuaternion(q).negate(),
    [centroid, q],
  );

  useLayoutEffect(() => {
    if (!camera.isOrthographicCamera) return;

    const fx = fixedHalfExtentsMm?.x;
    const fy = fixedHalfExtentsMm?.y;
    if (fx != null && fy != null && fx > 0 && fy > 0) {
      let sx = fx * SHEET_EDGE_SLACK;
      let sy = fy * SHEET_EDGE_SLACK;
      const g = canvasGutterPx ?? 0;
      if (g > 0 && size.width > 2 * g && size.height > 2 * g) {
        const iw = size.width - 2 * g;
        const ih = size.height - 2 * g;
        sx = (sx * size.width) / iw;
        sy = (sy * size.height) / ih;
      }
      camera.position.set(0, 0, 200);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      camera.left = -sx;
      camera.right = sx;
      camera.top = sy;
      camera.bottom = -sy;
      camera.near = 0.1;
      camera.far = 10000;
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      return;
    }

    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const vc = centroid;

    for (const s of solids) {
      const p = s.vertices;
      for (let i = 0; i < p.length; i += 3) {
        v.set(p[i] - vc.x, p[i + 1] - vc.y, p[i + 2] - vc.z).applyQuaternion(q);
        box.expandByPoint(v);
      }
    }

    if (box.isEmpty()) {
      camera.left = -1;
      camera.right = 1;
      camera.top = 1;
      camera.bottom = -1;
      camera.position.set(0, 0, 200);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      return;
    }

    const extent = box.getSize(new THREE.Vector3());
    let halfW = Math.max(extent.x / 2, 1e-6);
    let halfH = Math.max(extent.y / 2, 1e-6);

    const viewAspect = size.width / Math.max(size.height, 1e-6);
    const modelAspect = halfW / halfH;
    if (viewAspect > modelAspect) {
      halfW = halfH * viewAspect;
    } else {
      halfH = halfW / viewAspect;
    }

    halfW *= MARGIN;
    halfH *= MARGIN;

    camera.position.set(0, 0, 200);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);

    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.near = 0.1;
    camera.far = 10000;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
  }, [camera, solids, q, centroid, size.width, size.height, fixedHalfExtentsMm, canvasGutterPx]);

  return (
    <group position={offset} quaternion={q}>
      {children}
    </group>
  );
}

function SolidDepthOnly({ data }: { data: SolidMeshData }) {
  const meshGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
    g.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    g.computeVertexNormals();
    return g;
  }, [data.vertices, data.triangles]);

  useLayoutEffect(
    () => () => {
      meshGeom.dispose();
    },
    [meshGeom],
  );

  return (
    <mesh geometry={meshGeom} renderOrder={0}>
      <meshBasicMaterial colorWrite={false} depthWrite depthTest side={THREE.DoubleSide} />
    </mesh>
  );
}

function SolidEdgesOnly({ data }: { data: SolidMeshData }) {
  const positions = data.edgeVertices;
  const hasEdges = positions && positions.length >= 6;

  const meshGeom = useMemo(() => {
    if (hasEdges) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
    g.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    g.computeVertexNormals();
    return g;
  }, [data.vertices, data.triangles, hasEdges]);

  const lineGeom = useMemo(() => {
    if (!hasEdges) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions!, 3));
    return g;
  }, [hasEdges, positions]);

  useLayoutEffect(
    () => () => {
      meshGeom?.dispose();
      lineGeom?.dispose();
    },
    [meshGeom, lineGeom],
  );

  if (lineGeom) {
    return (
      <lineSegments geometry={lineGeom} renderOrder={1}>
        <lineBasicMaterial color="#1e293b" depthTest depthFunc={THREE.LessEqualDepth} />
      </lineSegments>
    );
  }

  if (meshGeom) {
    return (
      <mesh geometry={meshGeom} renderOrder={1}>
        <meshBasicMaterial color="#1e293b" wireframe depthTest depthFunc={THREE.LessEqualDepth} />
      </mesh>
    );
  }

  return null;
}

function FixedZUp() {
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    camera.up.set(0, 1, 0);
  });
  return null;
}

export function DrawingOrthoPreview({
  solids,
  orientation,
  viewPlaneHalfExtentsMm,
  className = '',
  viewId,
  dimensionMode = null,
  dimensions = [],
  onAddDimension,
  onUpdateDimensionGeometry,
  onDimensionContextMenu,
  canvasGutterPx = 0,
}: {
  solids: SolidMeshData[];
  orientation: [number, number, number, number];
  /** Half-width / half-height in view XY (mm). Omit in dialog preview (auto-fit + margin). */
  viewPlaneHalfExtentsMm?: { x: number; y: number } | null;
  className?: string;
  /** When set with handlers, enables linear dimension tools on this view. */
  viewId?: string;
  dimensionMode?: DrawingDimensionMode;
  dimensions?: DrawingSheetDimension[];
  onAddDimension?: (d: Omit<DrawingSheetDimension, 'id'>) => void;
  onUpdateDimensionGeometry?: (id: string, patch: { offsetMm?: number; alongMm?: number }) => void;
  onDimensionContextMenu?: (detail: { dimensionId: string; clientX: number; clientY: number }) => void;
  /**
   * Extra transparent pixels around the letterboxed model area (drawing sheet only). Widen the
   * ortho frustum so annotations can extend past the view frame without clipping.
   */
  canvasGutterPx?: number;
}) {
  const q = useMemo(
    () => new THREE.Quaternion(orientation[0], orientation[1], orientation[2], orientation[3]),
    [orientation],
  );

  const centroid = useMemo(() => computeModelCentroid(solids), [solids]);

  const offset = useMemo(
    () => new THREE.Vector3().copy(centroid).applyQuaternion(q).negate(),
    [centroid, q],
  );

  const dimHandlers =
    viewId && onAddDimension && onUpdateDimensionGeometry
      ? { viewId, onAddDimension, onUpdateDimensionGeometry, onDimensionContextMenu }
      : null;

  const hoveredDimensionId = useDrawingStore((s) => s.hoveredDimensionId);
  const dimensionHoverOnThisView =
    !!hoveredDimensionId && dimensions.some((d) => d.id === hoveredDimensionId);

  const sheetOverflow = canvasGutterPx > 0;
  return (
    <div
      className={`relative min-h-[220px] w-full bg-transparent ${className} ${
        sheetOverflow ? 'overflow-visible' : 'overflow-hidden rounded-md border border-zinc-300'
      }`}
      onPointerDown={(e) => {
        if (dimensionMode || dimensionHoverOnThisView) e.stopPropagation();
      }}
    >
      <Canvas
        orthographic
        dpr={[1, 2]}
        gl={{
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: true,
        }}
        className="!absolute inset-0 h-full w-full"
        onCreated={({ gl, scene }) => {
          gl.setClearColor(0x000000, 0);
          scene.background = null;
        }}
      >
        <OrthographicCamera makeDefault position={[0, 0, 200]} near={0.1} far={10000} />
        <OrthoAxisAlignedFit
          solids={solids}
          q={q}
          fixedHalfExtentsMm={viewPlaneHalfExtentsMm}
          centroid={centroid}
          canvasGutterPx={canvasGutterPx}
        >
          <group>
            {solids.map((s, i) => (
              <SolidDepthOnly key={`d_${s.featureId}_${i}`} data={s} />
            ))}
            {solids.map((s, i) => (
              <SolidEdgesOnly key={`e_${s.featureId}_${i}`} data={s} />
            ))}
          </group>
        </OrthoAxisAlignedFit>
        {dimHandlers && (
          <DrawingOrthoDimensionLayer
            solids={solids}
            q={q}
            offset={offset}
            viewId={dimHandlers.viewId}
            dimensionMode={dimensionMode}
            dimensions={dimensions}
            onAddDimension={dimHandlers.onAddDimension}
            onUpdateDimensionGeometry={dimHandlers.onUpdateDimensionGeometry}
            onDimensionContextMenu={dimHandlers.onDimensionContextMenu}
          />
        )}
        <FixedZUp />
      </Canvas>
    </div>
  );
}
