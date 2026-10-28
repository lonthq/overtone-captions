import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Type-level test: compiles the README usage with the TypeScript compiler, as a consumer of the package would.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const FILE = here('./__readme-usage__.ts');

const README_USAGE = `
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import 'videojs-overtone';
import 'videojs-overtone/themes/base.css';
import 'videojs-overtone/themes/clean.css';
import type { OvertoneController } from 'videojs-overtone';

const player = videojs('my-video');
const captions = player.overtone({
  src: 'clip.overtone.json',
  theme: 'clean',
  fallbackTracks: { horizontal: 'clip.horizontal.vtt', vertical: 'clip.vertical.vtt' },
});

await captions.ready;
captions.setTheme('social');
captions.cycle();
const typed: OvertoneController = captions;
const error: Error | undefined = typed.error;
player.overtone();
export { error };
`;

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
  paths: {
    'videojs-overtone': [here('../src/index.ts')],
    'videojs-overtone/core': [here('../src/core/index.ts')],
    'overtone-format': [here('../../format/src/index.ts')],
  },
};

/** The diagnostics of `source` (as FILE), formatted as "TS<code>: <message>". */
function diagnostics(source: string): string[] {
  const host = ts.createCompilerHost(OPTIONS);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === FILE ? ts.createSourceFile(name, source, languageVersion) : getSourceFile(name, languageVersion, ...rest);
  const fileExists = host.fileExists;
  host.fileExists = (name) => name === FILE || fileExists(name);
  const program = ts.createProgram([FILE], OPTIONS, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(FILE))
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

describe('TypeScript types for player.overtone()', () => {
  it('compiles the README usage', () => {
    expect(diagnostics(README_USAGE)).toEqual([]);
  }, 60_000);

  it('rejects an unknown option and the wrong return type', () => {
    const wrong = `
import videojs from 'video.js';
import 'videojs-overtone';
const captions = videojs('v').overtone({ them: 'clean' });
const mode: number = captions.getMode();
export { mode };
`;
    const found = diagnostics(wrong).map((line) => line.slice(0, line.indexOf(':')));
    expect(found).toEqual(['TS2561', 'TS2322']);
  }, 60_000);

  it('has no overtone() on Player without importing the plugin', () => {
    const bare = `
import videojs from 'video.js';
videojs('v').overtone();
`;
    expect(diagnostics(bare).map((line) => line.slice(0, line.indexOf(':')))).toEqual(['TS2339']);
  }, 60_000);
});
