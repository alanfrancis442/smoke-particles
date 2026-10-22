# igloo-particles

A WebGPU (Three.js r186 + TSL) recreation of the particle shapes in the closing section of [igloo.inc](https://www.igloo.inc/).

```sh
pnpm dev          # http://localhost:5173  (?count=60000 to change the particle count)
pnpm bake         # re-bake the SDF volumes in public/volumes after changing shapes (~3.5 min)
pnpm bake takeaway-cup vr  # …or only the named ones (keys of SHAPES in scripts/bake-sdf.mjs)
```

Move the cursor through the shape to stir it. Click the left or right half of the screen, swipe, or use ← → to switch shapes.

The three.js **Inspector** (top right) shows FPS, GPU timings and memory, and has a **Parameters** tab. It holds live sliders for shape scale and rotation, particle look (size, colours, lights, contrast), noise and forces, mouse fluid and bloom. Click **Export → copy settings JSON** to copy the current values to the clipboard (they are also logged to the console). Every value lives in `createParticleSettings()` in `src/particles.ts`, with the original igloo.inc constants in comments.

## How it works (same algorithm as the original)

- **150k particles** are simulated in one compute dispatch (`src/particles.ts`). Each particle is pulled onto the surface of a baked **128³ SDF volume** (gzipped `.vol` files; distance stored as a signed square root so 8 bits resolve sub-voxel detail near the surface), sprung back towards a random home position, and kept moving by **4D bitangent curl noise** (`src/noise.ts`). The SDF is sampled through a slow Y rotation, so the cloud keeps flowing around the shape. Detailed models with thin parts would smear at that speed, so each shape has a `flow` fraction (in `SHAPES` in `src/main.ts`, live under Shape → flow). Only that much of the spin goes through the SDF, and the rest rotates the whole cloud rigidly.
- **Mouse interaction** comes from a 128² screen-space **stable-fluids solver** on compute buffers (`src/fluid.ts`). Each particle samples the velocity under its projected screen position, and the push weakens the surface pull, so the cloud tears off in sheets and then re-forms.
- **Rendering** uses instanced camera-facing sprites drawn as sphere impostors. Lighting is baked per particle in the sim from the SDF normal (wrap diffuse). Fast-moving particles turn bright and partly transparent.
- **Shape switch:** all volumes sit in one stacked 3D texture, so switching is a uniform change plus a 0.5 s curl-noise burst.

## Credits

- Duck model: Khronos glTF Sample Assets, © 2006 Sony Computer Entertainment Inc., [SCEA Shared Source License 1.0](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Duck)
- Drone, F1 Wheel, AirPods Max, Takeaway Cup, Steam Deck and VR models: `assets-src/*.glb` (source and licence not recorded here). AirPods Max and Steam Deck are trademarks of their owners.
- The X and Medium logos are generated procedurally in `scripts/bake-sdf.mjs`. They are trademarks of their owners.
- Bitangent noise by Atyuwen (public domain).
