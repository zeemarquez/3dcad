import { loadPartDocument } from '@/app/documentStore';
import { buildAllSolids, initCAD, type SolidMeshData } from '@/modules/part/kernel/cadEngine';
import { featuresToCadFeatureInputs } from '@/modules/part/kernel/cadFeatureInputs';

export async function loadPartSolids(partId: string): Promise<SolidMeshData[]> {
  await initCAD();
  const doc = loadPartDocument(partId);
  if (!doc) return [];
  const inputs = featuresToCadFeatureInputs(doc.operations);
  return buildAllSolids(inputs);
}
