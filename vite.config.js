import { defineConfig } from 'vite';

/**
 * Deployed as a GitHub project page, so assets are served from a sub-path.
 * `base` feeds import.meta.env.BASE_URL, which is how src/main.js resolves
 * public/data/city.json — keep them in step if the repo is ever renamed.
 */
export default defineConfig({
  base: process.env.CITY_BASE ?? '/singapore-3d/',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});
