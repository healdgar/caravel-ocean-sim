import { createCaravelMesh, indexCaravelMesh } from './caravel.js';
import {createVictoryMesh} from './victory.js';
import { requirePlayableShipModel } from './ship-models.js';
import { deepFreeze } from './rig-definition.js';

// CPU geometry is immutable model data; transforms, crew poses, moisture and
// wake state remain per vessel. Consumers may share these buffers for uploads.
export function createShipAssetCache() {
  const assets = new Map();
  return {
    get(modelId = 'nina') {
      const model = requirePlayableShipModel(modelId);
      const key = JSON.stringify([model.id, model.revision]);
      if (!assets.has(key)) {
        // Do not let a planned rig accidentally reuse Niña's mesh or animation.
        const builders={nina:createCaravelMesh,victory:createVictoryMesh};
        if (!builders[model.id]) throw new Error(`No mesh builder for ready ship model ${model.id}`);
        const groups = [], raw = builders[model.id]({ groups });
        const { vertices, indices } = indexCaravelMesh(raw);
        assets.set(key, Object.freeze({ model, vertices, indices, groups: deepFreeze(groups) }));
      }
      return assets.get(key);
    },
  };
}
