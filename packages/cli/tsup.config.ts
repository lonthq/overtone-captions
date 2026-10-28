import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: false, // the build script empties dist: two configs write into it
    sourcemap: true,
    dts: false,
    external: ['overtone-format'],
  },
  {
    // The caption page of `overtone burn`: the player core and overtone-format bundled for the browser, plus the
    // theme CSS that videojs-overtone's build wrote (the root build builds packages/videojs first).
    entry: { page: 'src/burn/page/page.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    outDir: 'dist/burn',
    clean: false,
    sourcemap: false,
    dts: false,
    noExternal: [/.*/],
    outExtension: () => ({ js: '.js' }),
    esbuildOptions(options) {
      options.alias = {
        'videojs-overtone/core': here('../videojs/src/core/index.ts'),
        'overtone-format': here('../format/src/index.ts'),
      };
    },
    onSuccess: async () => {
      const from = here('../videojs/dist/themes');
      if (!existsSync(from)) throw new Error(`${from} is missing: build packages/videojs first (npm run build).`);
      const to = here('dist/burn/themes');
      mkdirSync(to, { recursive: true });
      for (const file of readdirSync(from)) if (file.endsWith('.css')) cpSync(`${from}/${file}`, `${to}/${file}`);
    },
  },
]);
