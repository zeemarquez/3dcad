import { useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Bounds, OrthographicCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { SolidMeshData } from '@/modules/part/kernel/cadEngine';

/** Same direction as Viewport3D "Iso" preset (scaled unit vector along X=Y=Z). */
const ISO_CAMERA_POS: [number, number, number] = [28, 28, 28];

function SolidPreviewMesh({ data }: { data: SolidMeshData }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    g.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    return g;
  }, [data]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#93c5fd" metalness={0.12} roughness={0.4} />
    </mesh>
  );
}

function PreviewScene({ solids }: { solids: SolidMeshData[] }) {
  return (
    <>
      <color attach="background" args={['#e8eef5']} />
      <ambientLight intensity={0.72} />
      <directionalLight position={[14, 22, 16]} intensity={1.05} />
      <directionalLight position={[-10, -8, -6]} intensity={0.32} />
      <Bounds fit clip observe margin={1.35}>
        <group>
          {solids.map((sd, i) => (
            <SolidPreviewMesh key={`${sd.featureId}_${i}`} data={sd} />
          ))}
        </group>
      </Bounds>
    </>
  );
}

interface PartThumbnailCanvasProps {
  solids: SolidMeshData[] | null;
  loading: boolean;
  emptyLabel?: string;
  className?: string;
}

export const PartThumbnailCanvas = ({
  solids,
  loading,
  emptyLabel = 'No solid geometry yet',
  className = '',
}: PartThumbnailCanvasProps) => {
  const showCanvas = solids && solids.length > 0;

  return (
    <div
      className={`relative w-full overflow-hidden rounded-md bg-zinc-200/80 ${className}`}
      style={{ aspectRatio: '4 / 3' }}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-100/90 z-10">
          <div className="h-6 w-6 rounded-full border-2 border-zinc-300 border-t-blue-500 animate-spin" aria-hidden />
        </div>
      )}
      {!loading && !showCanvas && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 px-3 text-center">
          {emptyLabel}
        </div>
      )}
      {showCanvas && (
        <Canvas orthographic dpr={[1, 2]} className="!absolute inset-0 h-full w-full">
          <OrthographicCamera makeDefault position={ISO_CAMERA_POS} near={0.1} far={20000} />
          <PreviewScene solids={solids} />
        </Canvas>
      )}
    </div>
  );
};
