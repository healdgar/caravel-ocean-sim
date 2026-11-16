// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Trained weights for the WebGPU 1-Step Conditional Flow & Game-Texture SR Pass.
export const NEURAL_LIGHT_WEIGHT_FLOATS = 1560;
export const NEURAL_LIGHT_WEIGHT_BYTES = 6240;
export const NEURAL_LIGHT_WEIGHTS_ASSET = "assets/neural-pbr/neural-light-weights.bin";

let cachedFast = null, cachedDepth = null, pendingWeights = null;

function decodeNeuralLightWeights(buf) {
  const bytes = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  cachedFast = new Float32Array(bytes, 0, NEURAL_LIGHT_WEIGHT_FLOATS);
  cachedDepth = new Float32Array(bytes, NEURAL_LIGHT_WEIGHT_BYTES, NEURAL_LIGHT_WEIGHT_FLOATS);
  return { fast: cachedFast, depth: cachedDepth };
}

if (typeof process !== "undefined" && process.versions?.node && typeof process.getBuiltinModule === "function") {
  const fsSync = process.getBuiltinModule("node:fs");
  const pathMod = process.getBuiltinModule("node:path");
  const urlMod = process.getBuiltinModule("node:url");
  const dir = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  decodeNeuralLightWeights(fsSync.readFileSync(pathMod.resolve(dir, "../../assets/neural-pbr/neural-light-weights.bin")));
}

export async function loadNeuralLightWeights() {
  if (cachedFast && cachedDepth) return { fast: cachedFast, depth: cachedDepth };
  if (pendingWeights) return pendingWeights;
  pendingWeights = (async () => {
    const res = await fetch(NEURAL_LIGHT_WEIGHTS_ASSET);
    if (!res.ok) throw new Error("Failed to fetch neural light weights (" + res.status + ")");
    return decodeNeuralLightWeights(await res.arrayBuffer());
  })();
  return pendingWeights;
}

export const NEURAL_LIGHT_WEIGHTS_FAST = cachedFast ?? new Float32Array(NEURAL_LIGHT_WEIGHT_FLOATS);
export const NEURAL_LIGHT_WEIGHTS_DEPTH = cachedDepth ?? new Float32Array(NEURAL_LIGHT_WEIGHT_FLOATS);
