import initOpenCascade from 'opencascade.js/dist/opencascade.wasm.js';
import openCascadeWasm from 'opencascade.js/dist/opencascade.wasm.wasm?url';

let oc: any = null;

self.onmessage = async (event: MessageEvent) => {
  const { type, id } = event.data;

  try {
    if (type === 'INIT') {
      if (!oc) {
        oc = await initOpenCascade({ locateFile: () => openCascadeWasm });
        console.log('[OCCT] Worker initialized');
      }
      self.postMessage({ type: 'INIT_DONE', id });
    } else if (type === 'EVALUATE_FEATURE_TREE') {
      // Geometry is now handled client-side via Three.js ExtrudeGeometry.
      // The worker is kept for future precision operations (fillets, booleans, etc.)
      self.postMessage({ type: 'EVALUATE_DONE', id, payload: { meshes: [] } });
    }
  } catch (error) {
    console.error('[OCCT] Worker error:', error);
    self.postMessage({ type: 'ERROR', id, error: String(error) });
  }
};
