import { createCaravelMesh, indexCaravelMesh } from './caravel.js';
import {createVictoryMesh} from './victory.js';
import {createAdditionalShipMesh} from './additional-ships.js';
import {createRowingShipMesh} from './rowing-ships.js';
import {createLaterSailShipMesh} from './later-sail-ships.js';
import {createRigGPUData} from './rig-gpu-data.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {LATER_SAIL_DESIGNS} from './models/later-sail.js';
import { requirePlayableShipModel } from './ship-models.js';
import { deepFreeze } from './rig-definition.js';
import { createPartAssemblyCatalog } from './part-assembly.js';

// CPU geometry is immutable model data; transforms, crew poses, moisture and
// wake state remain per vessel. Consumers may share these buffers for uploads.
const sharedShipAssets = new Map();
export function createShipAssetCache() {
  const assets = sharedShipAssets;
  return {
    get(modelId = 'nina') {
      const model = requirePlayableShipModel(modelId);
      if(model.gpuPose!==true)throw Error('Ship graphics require the shared WebGPU pose pipeline: '+model.id);
      const key = JSON.stringify([model.id, model.revision]);
      if (!assets.has(key)) {
        // Do not let a planned rig accidentally reuse Niña's mesh or animation.
        const builders={nina:createCaravelMesh,victory:createVictoryMesh,pinta:options=>createAdditionalShipMesh('pinta',options),'santa-maria':options=>createAdditionalShipMesh('santa-maria',options)};
        for(const id of Object.keys(ROWING_DESIGNS))builders[id]=options=>createRowingShipMesh(id,options);
        for(const id of Object.keys(LATER_SAIL_DESIGNS))builders[id]=options=>createLaterSailShipMesh(id,options);
        if (!builders[model.id]) throw new Error(`No mesh builder for ready ship model ${model.id}`);
        const groups = [], raw = builders[model.id]({ groups });
        const { vertices, indices } = indexCaravelMesh(raw);
        const partAssembly = createPartAssemblyCatalog({
          domain: 'ship',
          modelId: model.id,
          vertices,
          vertexStride: 9,
          indices,
          groups,
        });
        const asset={ model, vertices, indices, groups: deepFreeze(groups), partAssembly, gpuPose:true };
        if(model.rig?.backend==='surfaces-v1'){
          asset.rigGPUData=createRigGPUData(asset);
        }
        assets.set(key, Object.freeze(asset));
      }
      return assets.get(key);
    },
  };
}
