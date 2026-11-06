# Graphics execution contract

Per-frame graphics transformations belong on WebGPU throughout the scene: every ship (player, AI, companion or background), crew, wildlife, vegetation, water and visual effects. Adding a ship supplies model data to the shared renderer; it does not create a JavaScript mesh-animation backend. Main, shadow, submerged and wetness passes consume the same computed position/normal buffer.

JavaScript may prepare immutable geometry and GPU metadata once, integrate sparse physical state, solve crew tasks/IK, and upload compact controls, joints or instance transforms. Cannon recoil supplies compact gun transforms to the shared GPU pose stage. JavaScript must not animate vertex positions, upload a deformed vessel mesh each frame, regenerate material probes from that mesh, or read posed vertices back to feed another render pass.

A CPU graphics exception requires a concrete measured performance or transfer-latency advantage, a bounded workload, and regression coverage. No ship-class exemption is presently justified. CPU reference evaluators remain available to offline validation; runtime assets expose no CPU pose callback.

`tests/gpu-vessel-contract.test.mjs` checks registry assets and forbidden runtime paths. `tests/gpu-vessel-contract-gpu.test.mjs` observes actual production GPU commands, buffer sharing, direct uploads and staging-buffer copies. It requires sufficient canonical pose workgroups, then deliberately injects disabled, zero-work, incomplete and recoil-only dispatches, CPU callbacks, direct mesh uploads and CPU staging copies to prove rejection and recovery. Native pose parity tests compare physical positions and normals rather than trusting a GPU flag. These tests do not establish a frame-rate guarantee on a physical device.

## Fragment work on tile-based GPUs

Apple GPUs shade only what is visible, but only for draws that neither discard nor blend. Measured on an M4 Max, a `discard` on a path no fragment ever took still cost a ship scene a quarter or more of its frame. These rules follow from that.

- **One render pass for the scene.** Leaving a pass writes the multisampled attachments out to memory, and the next pass reads them back. What needs the scene mid-frame reads last frame's image instead, as ship timber's water reflection does.
- **Opaque first.** Whole hulls, then terrain, then the sea and sky, then anything that cuts or blends. A hull drawn first also saves shading the sea under it.
- **A surface that can be cut lays depth first.** A small entry decides what survives, then shading runs at `depthCompare:'equal'` with no `discard`. The ocean, forest leaves, damaged hulls and sailors who can be cut all work this way.
- **Do not compile what is not there.** A whole ship has no damage code and the open sea has no coastal code: each is a second pipeline from the same source, chosen per draw. Large untaken branches still cost time.
- **WGSL `select` evaluates both arguments.** Never pass it a ray march.
- **Slow-changing answers are baked.** Land sunlight, coastal wave shelter and each ship's blurred sea shadow live in textures. A per-pixel loop over texture fetches needs a reason.
- **Lists are made on the GPU.** Scenery culling, tree level of detail and cluster cuts run in compute passes that write indirect draws, and bodies with nothing to reach for pose from clips baked once. A JavaScript loop over instances needs a reason.
- **What follows from the time alone keeps no state.** A town's people are a route, a phase and a speed. A compute pass works out where each one is, culls them and picks their detail, and the vertex stage reads their pose straight from the baked clips, so no joints are computed or stored per body and JavaScript touches no one after the town is laid out.
- **Timestamps stall the frame they sample.** They run only while the performance panel is open, and their spans include waits, so nothing automatic may read them.
- **Each buffer holds one thing.** Battle damage has its own uniform buffer rather than the tail of another system's storage.
- **Damage does not edit geometry.** A break writes one flight record. The compute pass that moves shards runs only on ships that have lost something.
- **A ruin costs no compute.** A building has no pose stage to repeat, so its pass runs only while pieces are in the air, and what it wrote stays in the vertex buffer. The faces inside a wall are points until a break opens them.
