# Graphics execution contract

Per-frame graphics transformations belong on WebGPU throughout the scene: every ship (player, AI, companion or background), crew, wildlife, vegetation, water and visual effects. Adding a ship supplies model data to the shared renderer; it does not create a JavaScript mesh-animation backend. Main, shadow, submerged and wetness passes consume the same computed position/normal buffer.

JavaScript may prepare immutable geometry and GPU metadata once, integrate sparse physical state, solve crew tasks/IK, and upload compact controls, joints or instance transforms. Cannon recoil supplies compact gun transforms to the shared GPU pose stage. JavaScript must not animate vertex positions, upload a deformed vessel mesh each frame, regenerate material probes from that mesh, or read posed vertices back to feed another render pass.

A CPU graphics exception requires a concrete measured performance or transfer-latency advantage, a bounded workload, and regression coverage. No ship-class exemption is presently justified. CPU reference evaluators remain available to offline validation; runtime assets expose no CPU pose callback.

`tests/gpu-vessel-contract.test.mjs` checks registry assets and forbidden runtime paths. `tests/gpu-vessel-contract-gpu.test.mjs` observes actual production GPU commands, buffer sharing, direct uploads and staging-buffer copies. It requires sufficient canonical pose workgroups, then deliberately injects disabled, zero-work, incomplete and recoil-only dispatches, CPU callbacks, direct mesh uploads and CPU staging copies to prove rejection and recovery. Native pose parity tests compare physical positions and normals rather than trusting a GPU flag. These tests do not establish a frame-rate guarantee on a physical device.
