import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const shim = fileURLToPath(new URL('./src/shims/videojs-global.ts', import.meta.url));

export default defineConfig([
  {
    // npm consumers: ESM + types; video.js and overtone-format stay external.
    entry: { index: 'src/index.ts', core: 'src/core/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    target: 'es2022',
    external: ['video.js', 'overtone-format'],
    // The theme CSS (base.css and the style packs) is copied by scripts/style-packs.mjs after tsup.
  },
  {
    // <script> users: dist/index.global.js exposes window.OvertoneVideojs (the plugin entry plus core) and uses
    // the global videojs.
    entry: { index: 'src/global.ts' },
    format: ['iife'],
    globalName: 'OvertoneVideojs',
    sourcemap: true,
    target: 'es2020',
    noExternal: ['overtone-format'],
    esbuildOptions(options) {
      options.alias = { 'video.js': shim };
    },
  },
]);
