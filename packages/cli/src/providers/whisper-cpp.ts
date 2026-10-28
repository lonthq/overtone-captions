import { spawn } from 'node:child_process';
import { constants, statSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import type { TimedWord } from '../types.js';
import { onInterrupt } from '../util/interrupt.js';
import { makeTempDir } from '../util/temp-file.js';
import { defineProvider, envFlag, envInt, envString, MIN_WORD_SECONDS, round3, WHISPER_PROMPT_CHARS, withSettings, type ProviderDescriptor, type UsageCallback } from './kit.js';
import type { AudioChunk, AudioFile, TextOptions, TextProvider, TextResult, TimingOptions, TimingProvider } from './types.js';

/**
 * whisper.cpp (https://github.com/ggml-org/whisper.cpp) via the local `whisper-cli`: free, offline, one call on the
 * whole WAV, token timestamps from `--output-json-full`. Serves text, timing, or both from one call
 * (`--text whisper-cpp:base --timing same`).
 *
 * Flags as of whisper-cli 1.9.5 (2026-10-17): `-m` model, `-f` file, `-l` language ('auto' detects; default 'en'),
 * `--prompt` (max n_text_ctx/2 tokens), `-oj` + `-ojf` (JSON with per-segment `tokens`, `offsets.from/to` in ms),
 * `-of` output path without extension, `-np` no prints, `-tdrz` tinydiarize (needs a tdrz model; sets
 * `speaker_turn_next` on a segment), `-t` threads.
 */

/** Default folder for `ggml-<model>.bin` files. */
export const DEFAULT_MODEL_DIR = join(homedir(), '.cache', 'whisper.cpp');

/** Disk sizes from whisper.cpp's models/README.md, for the download hint. */
const MODEL_SIZES: Record<string, string> = {
  tiny: '75 MiB', 'tiny.en': '75 MiB', base: '142 MiB', 'base.en': '142 MiB', small: '466 MiB', 'small.en': '466 MiB',
  'small.en-tdrz': '465 MiB', medium: '1.5 GiB', 'medium.en': '1.5 GiB', 'large-v3': '2.9 GiB', 'large-v3-q5_0': '1.1 GiB',
  'large-v3-turbo': '1.5 GiB', 'large-v3-turbo-q5_0': '547 MiB',
};

/** The `--output-json-full` file (fields we use). */
export interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{
    offsets?: { from: number; to: number };
    text?: string;
    tokens?: Array<{ text: string; offsets?: { from: number; to: number }; p?: number }>;
    /** Only with -tdrz: the next segment is another speaker. */
    speaker_turn_next?: boolean;
  }>;
}

/** Special tokens ("[_BEG_]", "[_TT_240]", "[_SOT_]") and tinydiarize's "[SPEAKER_TURN]". */
const SPECIAL = /^\s*\[(_[^\]]*_?|SPEAKER_TURN)\]\s*$/;
/** A non-speech annotation segment: "[BLANK_AUDIO]", "(music)", "[Applause]". */
const ANNOTATION = /^\s*[[(][^\])]*[\])]\s*$/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Whisper tokens → timed words. A token starting with a space starts a word; others ("ora" in " Lum" "ora", ",",
 * "'re") join it. A word ends at its last token with a letter or digit, so trailing punctuation (often spanning a
 * pause) does not stretch it. Words get at least MIN_WORD_SECONDS; annotation-only segments are skipped. Speaker
 * "S1", or with tinydiarize alternating S1 ↔ S2 after each `speaker_turn_next`.
 */
export function mapWhisperJson(json: WhisperJson, opts: { tdrz?: boolean } = {}): { text: string; words: TimedWord[]; language?: string } {
  const words: TimedWord[] = [];
  let speaker = 1;
  for (const seg of json.transcription ?? []) {
    const turn = opts.tdrz === true && seg.speaker_turn_next === true;
    if (!ANNOTATION.test(seg.text ?? '')) {
      let cur: (TimedWord & { probs: number[] }) | undefined;
      const flush = () => {
        if (!cur) return;
        const text = cur.text.trim();
        if (text && !/^\[[^\]]*\]$/.test(text)) {
          const { probs, ...w } = cur;
          const confidence = probs.length > 0 ? probs.reduce((a, b) => a + b, 0) / probs.length : undefined;
          words.push({ ...w, text, ...(confidence !== undefined ? { confidence: round3(confidence) } : {}) });
        }
        cur = undefined;
      };
      for (const tok of seg.tokens ?? []) {
        if (SPECIAL.test(tok.text)) continue;
        const from = tok.offsets ? tok.offsets.from / 1000 : undefined;
        const to = tok.offsets ? tok.offsets.to / 1000 : undefined;
        if (!cur || /^\s/.test(tok.text)) {
          flush();
          if (from === undefined || to === undefined) continue; // no time to anchor a new word on
          cur = { text: tok.text, start: from, end: to, speaker: `S${speaker}`, probs: [] };
        } else {
          cur.text += tok.text;
        }
        if (HAS_WORD_CHAR.test(tok.text)) {
          if (to !== undefined) cur.end = Math.max(cur.end, to);
          if (typeof tok.p === 'number' && Number.isFinite(tok.p)) cur.probs.push(tok.p);
        }
      }
      flush();
    }
    if (turn) speaker = speaker === 1 ? 2 : 1;
  }
  words.sort((a, b) => a.start - b.start);
  for (const w of words) {
    w.start = round3(w.start);
    w.end = round3(Math.max(w.end, w.start + MIN_WORD_SECONDS));
  }
  const language = json.result?.language && json.result.language !== 'auto' ? json.result.language : undefined;
  return { text: words.map((w) => w.text).join(' '), words, ...(language ? { language } : {}) };
}

/** A file path rather than a model name? */
const isPath = (model: string) => /[/\\]/.test(model) || model.endsWith('.bin');

/** Expands a leading "~/" (not every shell or .env loader does). */
const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() === true;
}
const isDirSync = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * A path is used as is; a name (`base`, `small.en`) becomes `ggml-<name>.bin` in the WHISPER_CPP_MODEL folder or
 * ~/.cache/whisper.cpp. A WHISPER_CPP_MODEL file wins over the name.
 */
export function resolveModelFile(model: string, env: NodeJS.ProcessEnv, cwd: string): { path: string; name: string } {
  if (isPath(model)) return { path: resolve(cwd, expandHome(model)), name: model };
  const pinned = envString(env, 'WHISPER_CPP_MODEL');
  if (pinned) {
    const p = resolve(cwd, expandHome(pinned));
    if (isDirSync(p)) return { path: join(p, `ggml-${model}.bin`), name: model };
    return { path: p, name: model };
  }
  return { path: join(DEFAULT_MODEL_DIR, `ggml-${model}.bin`), name: model };
}

/** Download URL, as in whisper.cpp's models/download-ggml-model.sh. */
export function modelUrl(name: string): string {
  return name.includes('tdrz')
    ? `https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-${name}.bin`
    : `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
}

export function missingModelMessage(path: string, name: string): string {
  if (isPath(name)) return `whisper.cpp model file not found: ${path}`;
  const size = MODEL_SIZES[name];
  return [
    `whisper.cpp model not found: ${path}`,
    `Download it${size ? ` (${size})` : ''} once:`,
    `  mkdir -p "${resolve(path, '..')}"`,
    `  curl -L --fail -o "${path}" ${modelUrl(name)}`,
    `(or run whisper.cpp's models/download-ggml-model.sh ${name} and set WHISPER_CPP_MODEL to the file). Models: tiny, base,`,
    'small, medium, large-v3-turbo; ".en" variants (base.en) are English-only and more accurate for English.',
  ].join('\n');
}

export const INSTALL_HINT = [
  'Install whisper.cpp:',
  '  macOS (Homebrew):  brew install whisper-cpp',
  '  other systems:     build it from https://github.com/ggml-org/whisper.cpp',
  '                     (cmake -B build && cmake --build build -j --config Release; the binary is build/bin/whisper-cli)',
  'or set WHISPER_CPP_BIN to the whisper-cli binary.',
].join('\n');

/** A path is checked as given; a bare name is looked up on PATH. */
export async function findExecutable(name: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
  const ok = async (p: string) => (await isFile(p)) && (await access(p, constants.X_OK).then(() => true, () => false));
  if (isAbsolute(name) || /[/\\]/.test(name)) {
    const p = resolve(cwd, expandHome(name));
    return (await ok(p)) ? p : undefined;
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) if (await ok(join(dir, name + ext))) return join(dir, name + ext);
  }
  return undefined;
}

const binaryName = (env: NodeJS.ProcessEnv) => envString(env, 'WHISPER_CPP_BIN') ?? 'whisper-cli';

/** What to spawn: a path resolved like findExecutable does, a bare name as given (PATH). */
export const binaryPath = (env: NodeJS.ProcessEnv, cwd: string): string => {
  const name = binaryName(env);
  return isAbsolute(name) || /[/\\]/.test(name) || name === '~' ? resolve(cwd, expandHome(name)) : name;
};

/** The last `max` characters of `prompt`, starting at a word boundary. */
export function promptTail(prompt: string | undefined, max = WHISPER_PROMPT_CHARS): string | undefined {
  if (!prompt) return undefined;
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat || undefined;
  const cut = flat.slice(-max);
  const space = cut.indexOf(' ');
  return (space >= 0 ? cut.slice(space + 1) : cut) || undefined;
}

export interface WhisperCppConfig {
  /** Path, or name on PATH. */
  bin: string;
  modelPath: string;
  /** As selected ("base", "small.en-tdrz"). */
  modelName: string;
  /** Pass -tdrz (needs a tdrz model). */
  tdrz: boolean;
  threads?: number;
  /** From WHISPER_CPP_ARGS, e.g. ["-ng"] or ["--vad", "-vm", "…"]. */
  extraArgs: string[];
  log?: Logger;
  usage?: UsageCallback;
  /** Subprocess environment (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export class WhisperCppProvider implements TextProvider, TimingProvider {
  readonly input = 'wav' as const;
  constructor(readonly id: string, private readonly cfg: WhisperCppConfig) {}

  /** Arguments for one run, without the output path. */
  args(wav: string, opts: { language?: string; prompt?: string }): string[] {
    const english = /\.en(\b|-|$)/.test(this.cfg.modelName);
    const language = opts.language?.toLowerCase().split(/[-_]/)[0] || (english ? 'en' : 'auto');
    const prompt = promptTail(opts.prompt);
    return [
      '-m', this.cfg.modelPath,
      '-f', wav,
      '-l', language,
      '-oj', '-ojf',
      '-np',
      ...(prompt ? ['--prompt', prompt] : []),
      ...(this.cfg.tdrz ? ['-tdrz'] : []),
      ...(this.cfg.threads ? ['-t', String(this.cfg.threads)] : []),
      ...this.cfg.extraArgs,
    ];
  }

  private async run(audio: { path: string; seconds: number }, opts: { language?: string; prompt?: string }): Promise<{ text: string; words: TimedWord[]; language?: string }> {
    // also removed on a stop, after whisper-cli is killed (newest cleanup first)
    const dir = await makeTempDir('overtone-whisper-');
    const out = join(dir.path, 'out');
    try {
      const args = [...this.args(audio.path, opts), '-of', out];
      const minutes = (audio.seconds / 60).toFixed(1);
      this.cfg.log?.info(`  whisper.cpp: ${minutes} min of audio with ${this.cfg.modelName} (local; roughly 1 to 10 s per minute, depending on model and machine)`);
      await new Promise<void>((done, fail) => {
        const child = spawn(this.cfg.bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.cfg.env ?? process.env });
        // SIGTERM reaches only this process; without this, whisper-cli keeps running and writing
        const forget = onInterrupt(() => child.kill('SIGKILL'));
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
        child.on('error', (err: NodeJS.ErrnoException) => {
          forget();
          fail(err.code === 'ENOENT' || err.code === 'EACCES' ? new UserError(`whisper-cli could not be started (${this.cfg.bin}: ${err.code}).\n${INSTALL_HINT}`) : err);
        });
        child.on('close', (code, signal) => {
          forget();
          if (code === 0) return done();
          const tail = stderr.trim().split('\n').slice(-5).join('\n');
          fail(new Error(`whisper-cli ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}${tail ? `:\n${tail}` : ''}`));
        });
      });
      let json: WhisperJson;
      try {
        json = JSON.parse(await readFile(`${out}.json`, 'utf8')) as WhisperJson;
      } catch (err) {
        throw new Error(`whisper-cli wrote no readable JSON (${(err as Error).message}); is it whisper.cpp 1.5 or newer (with --output-json-full)?`);
      }
      const res = mapWhisperJson(json, { tdrz: this.cfg.tdrz });
      this.cfg.usage?.({ audioSeconds: audio.seconds });
      return res;
    } finally {
      await dir.remove();
    }
  }

  async transcribe(audio: AudioChunk, opts: TextOptions): Promise<TextResult> {
    const res = await this.run({ path: audio.path, seconds: Math.max(0, audio.end - audio.start) }, { language: opts.language, prompt: opts.prompt });
    return { text: res.text, words: res.words, ...(res.language ? { language: res.language } : {}) };
  }

  async align(audio: AudioFile, opts: TimingOptions): Promise<{ words: TimedWord[]; language?: string }> {
    const phrases = (opts.phrases ?? []).filter((p) => p.trim()).join(', ');
    const res = await this.run({ path: audio.path, seconds: audio.duration }, { language: opts.language, prompt: phrases ? `Names and terms: ${phrases}.` : undefined });
    return { words: res.words, ...(res.language ? { language: res.language } : {}) };
  }
}

/** WHISPER_CPP_THREADS: a positive integer or undefined; else a user error. */
const threadsFrom = (env: NodeJS.ProcessEnv): number | undefined => envInt(env, 'WHISPER_CPP_THREADS', 1);

export const whisperCppProvider: ProviderDescriptor = defineProvider({
  id: 'whisper-cpp',
  description: 'whisper.cpp on this machine (free, offline; text + word timings; speaker turns only with a tdrz model)',
  roles: ['text', 'timing'],
  env: [
    { name: 'WHISPER_CPP_BIN', description: 'the whisper-cli binary (default: whisper-cli on PATH)' },
    { name: 'WHISPER_CPP_MODEL', description: `a folder with ggml-<model>.bin files (default ~/.cache/whisper.cpp), or one model file` },
    { name: 'WHISPER_CPP_TDRZ', description: '1 = pass -tdrz (speaker turns) with a custom tdrz model file; automatic for *tdrz* model names' },
    { name: 'WHISPER_CPP_THREADS', description: 'CPU threads (whisper-cli -t; default 4)' },
    { name: 'WHISPER_CPP_ARGS', description: 'extra whisper-cli arguments, space-separated, e.g. "-ng" (no GPU)' },
  ],
  // large-v3-turbo: the best speed/accuracy trade-off of the whisper.cpp models; base (142 MiB) is the fast option
  defaults: { text: 'large-v3-turbo', timing: 'large-v3-turbo' },
  modelHint: 'a model name such as base, small.en or small.en-tdrz, or a path to a ggml .bin file',
  wordTimings: true,
  async preflight(env, model, deps) {
    const bin = await findExecutable(binaryName(env), env, deps.cwd);
    const pinned = envString(env, 'WHISPER_CPP_BIN');
    if (!bin) throw new UserError(`whisper-cli (whisper.cpp) not found${pinned ? ` at WHISPER_CPP_BIN=${pinned}` : ' on PATH'}.\n${INSTALL_HINT}`);
    const file = resolveModelFile(model, env, deps.cwd);
    if (!(await isFile(file.path))) throw new UserError(missingModelMessage(file.path, file.name));
    threadsFrom(env);
    envFlag(env, 'WHISPER_CPP_TDRZ');
  },
  create(env, model, deps) {
    const modelPath = resolveModelFile(model, env, deps.cwd).path;
    const tdrz = envFlag(env, 'WHISPER_CPP_TDRZ') || model.includes('tdrz');
    const extraArgs = (envString(env, 'WHISPER_CPP_ARGS') ?? '').split(/\s+/).filter(Boolean);
    const provider = new WhisperCppProvider(deps.id, {
      bin: binaryPath(env, deps.cwd),
      modelPath,
      modelName: model,
      tdrz,
      threads: threadsFrom(env),
      extraArgs,
      log: deps.log,
      usage: deps.usage,
      env,
    });
    // cache key: the model file (WHISPER_CPP_MODEL may pin another), speaker turns, extra arguments
    return withSettings(provider, { modelFile: basename(modelPath), tdrz: tdrz || undefined, args: extraArgs.length > 0 ? extraArgs : undefined });
  },
});
