// Regression gate fixture: one clip's frozen hearings and its reference, text only. Written by bench/gate-freeze.mjs;
// committed in test/fixtures/bench/ (sources and licenses in its README.md), private ones in bench/private/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** A word as an engine heard it (seconds). */
export interface BenchWord { text: string; start: number; end: number; speaker?: string; confidence?: number }
/** A reference word; AMI has times, the read-speech references only text. */
export interface RefWord { text: string; start?: number; end?: number; speaker?: string }
/** A reference subtitle cue. */
export interface RefCue { start: number; end: number; text: string }

export interface Reference {
  /** Where it comes from and its license. */
  source: string;
  /** Human reference words in reading order (WER; word timing when they have times). */
  words?: RefWord[];
  /** Human subtitle cues (WER on their text, cue timing). */
  cues?: RefCue[];
}

export interface Fixture {
  id: string;
  title: string;
  kind: string;
  /** The language the align stage used (the run's align.json). */
  language: string;
  duration: number;
  license: string;
  attribution: string;
  /** Engines may have trained on public clips. `high` (e.g. the Blender films): engines are not compared on it. */
  contamination: { level: 'high' | 'possible' | 'none'; note: string };
  /**
   * The text hearing: chunks as first answered (`raw`), the one retry of an empty chunk (`retry`, '' if still empty),
   * the chunks after the coverage step at freeze time (`covered`, for the spans) and each chunk's prompt (echo guard).
   */
  text: { provider: string; raw: string[]; retry?: string[]; prompt?: Array<string | undefined>; covered: Array<{ start: number; end: number; text: string; source?: string; filled?: boolean; regions?: boolean }> };
  /** Context and names as the text vote's chooser gets them. */
  context?: string;
  names?: string[];
  /** Frozen snippet re-listens of the text engine, by run.ts `textKey`. */
  relistenText?: Record<string, string>;
  /** Frozen answers of the vote's chooser, by run.ts `llmKey`. */
  llm?: Record<string, unknown>;
  /** The timing hearing of the whole file (before any timing heuristics). */
  timing: { provider: string; language?: string; words: BenchWord[] };
  /**
   * Re-listens: the listeners in order and their words per window ("<startMs>-<endMs>", times relative to the window
   * start). A window missing here gets no words and counts as a miss.
   */
  relisten: { listeners: string[]; windows: Record<string, Record<string, BenchWord[]>> };
  /** Other engines' hearings of the whole file, for the engine table (bench/gate.mjs). */
  hearings: Record<string, { provider: string; note: string; words: BenchWord[] }>;
  /** Human reference committed with the fixture. */
  reference?: Reference;
  /** An uncommitted human reference (license unclear): a repo-relative SRT path; its metrics are skipped when absent. */
  localReference?: { path: string; format: 'srt'; source: string };
  /** A hearing whose word times stand in as the word-timing reference (no human word times): machine, not truth. */
  timingReference?: string;
  /** What could not be frozen. */
  notes?: string[];
  /** Audio without speech (bench/clips.nonspeech.json): every output word is a hallucination (gated as output.words). */
  nonSpeech?: boolean;
  /** Seconds before the first spoken word (e.g. music); output words starting earlier are gated as output.early. */
  speechStart?: number;
}

/** The repository root: the first folder up with the fixtures (also from the bundle, bench/gate.mjs). */
function findRepo(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'packages/cli/test/fixtures/bench'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) throw new Error('regression gate: repository root not found');
    dir = up;
  }
}
export const REPO = findRepo();
/** The committed fixtures. */
export const FIXTURE_DIR = join(REPO, 'packages/cli/test/fixtures/bench');
/** A private clip set (never published, git-ignored): same format, run when present. */
export const PRIVATE_DIR = join(REPO, 'bench/private');

export function readFixture(path: string): Fixture {
  const raw = readFileSync(path);
  return JSON.parse((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')) as Fixture;
}

/** The fixtures of a folder (`*.fixture.json` or `*.fixture.json.gz`), sorted by id; none when the folder is absent. */
export function loadFixtures(dir: string): Fixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.fixture\.json(\.gz)?$/.test(f))
    .sort()
    .map((f) => readFixture(join(dir, f)));
}

/** "HH:MM:SS,mmm --> HH:MM:SS,mmm" blocks → cues. */
export function parseSrt(text: string): RefCue[] {
  const out: RefCue[] = [];
  for (const block of text.replace(/^﻿/, '').replace(/\r/g, '').trim().split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const at = lines.findIndex((l) => /-->/.test(l));
    if (at < 0) continue;
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines[at]!);
    if (!m) continue;
    const g = m.slice(1).map(Number);
    const t = (h: number, mi: number, s: number, ms: number) => h * 3600 + mi * 60 + s + ms / 1000;
    out.push({ start: t(g[0]!, g[1]!, g[2]!, g[3]!), end: t(g[4]!, g[5]!, g[6]!, g[7]!), text: lines.slice(at + 1).join(' ').trim() });
  }
  return out;
}

/** The clip's human reference: the committed one, else the local one when its file is present. */
export function referenceOf(f: Fixture): Reference | undefined {
  if (f.reference) return f.reference;
  if (!f.localReference) return undefined;
  const path = join(REPO, f.localReference.path);
  if (!existsSync(path)) return undefined;
  return { source: f.localReference.source, cues: parseSrt(readFileSync(path, 'utf8')) };
}
