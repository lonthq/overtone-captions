import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^overtone-format$/, replacement: here('./packages/format/src/index.ts') },
      { find: /^videojs-overtone\/core$/, replacement: here('./packages/videojs/src/core/index.ts') },
      { find: /^overtone-format\/schema\.json$/, replacement: here('./packages/format/overtone.schema.json') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
    // Pipeline tests run ffmpeg; on a busy machine or a CI runner they can take longer than vitest's 5 s default.
    testTimeout: 20_000,
    // Tests never download: the CMU Pronouncing Dictionary comes from the dev dependency (reconcile/cmudict.ts).
    env: { OVERTONE_CMUDICT: here('./node_modules/cmu-pronouncing-dictionary/index.js') },
  },
});
