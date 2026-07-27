import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Post-processing chain: scene -> bloom -> tone map / sRGB.
 *
 * Bloom is what sells the night view; the lit windows, street lamps, car lamps
 * and Supertree panels are all emissive geometry that only reads as light once
 * it blooms. The render target is multisampled so building edges stay clean
 * without a separate AA pass.
 */
export function createComposer(renderer, scene, camera, quality) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: quality.aa,
    colorSpace: THREE.LinearSRGBColorSpace,
  });

  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.2, 0.62, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  return {
    composer,
    bloom,
    render(dt) { composer.render(dt); },
    setLook(look) {
      bloom.strength = look.bloomStrength;
      bloom.threshold = look.bloomThreshold;
      renderer.toneMappingExposure = look.exposure;
    },
    resize(w, h) {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },
    dispose() {
      composer.dispose();
      target.dispose();
    },
  };
}
