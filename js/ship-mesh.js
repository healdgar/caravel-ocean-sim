import { createCaravelMesh, indexCaravelMesh } from './caravel.js';
import {createVictoryMesh} from './victory.js';
import {createAdditionalShipMesh,createAdditionalAssetPose} from './additional-ships.js';
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
        const builders={nina:createCaravelMesh,victory:createVictoryMesh,pinta:options=>createAdditionalShipMesh('pinta',options),'santa-maria':options=>createAdditionalShipMesh('santa-maria',options)};
        if (!builders[model.id]) throw new Error(`No mesh builder for ready ship model ${model.id}`);
        const groups = [], raw = builders[model.id]({ groups });
        const { vertices, indices } = indexCaravelMesh(raw);
        const asset={ model, vertices, indices, groups: deepFreeze(groups) };
        if(model.rig?.backend==='surfaces-v1'){asset.gpuPose=false;asset.pose=createAdditionalAssetPose(asset);}
        assets.set(key, Object.freeze(asset));
      }
      return assets.get(key);
    },
  };
}
