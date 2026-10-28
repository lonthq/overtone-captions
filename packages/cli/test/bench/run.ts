// Runs the pipeline offline on a frozen fixture, from the hearings to rule-based line cutting: the providers answer
// from the fixture and the refine LLM steps are no-ops. Keep in step with src/pipeline/.
import { createHash } from 'node:crypto';
import { roundTime, type Profile } from 'overtone-format';
import { snapWindow, type TimingRetry } from '../../src/align/relisten.js';
import { stableStringify } from '../../src/cache.js';
import { resolveConfig } from '../../src/config.js';
import { findPromptEcho } from '../../src/echo.js';
import { hear, speakerEngine, textBase, type EngineHearing } from '../../src/hearings.js';
import { memoryLogger } from '../../src/log.js';
import type { LlmProvider, LlmRequest } from '../../src/providers/types.js';
import type { TextVote } from '../../src/reconcile/vote.js';
import { refine } from '../../src/refine/llm-steps.js';
import { LATEST_RULESET } from '../../src/segment/rulesets/index.js';
import { tokenizeDisplay } from '../../src/text/normalize.js';
import { buildTurns, flattenTurns, type SpeakerWord } from '../../src/turns.js';
import type { BenchWord, Fixture } from './fixture.js';

/** "<startMs>-<endMs>", the key of a relisten window. */
export const spanKey = (start: number, end: number) => `${Math.round(start * 1000)}-${Math.round(end * 1000)}`;
/** Key of a frozen snippet re-listen of the text engine: the window and a hash of the prompt. */
export const textKey = (start: number, end: number, prompt: string | undefined) => `${spanKey(start, end)}|${createHash('sha256').update(prompt ?? '').digest('hex').slice(0, 12)}`;
/** Key of a frozen LLM answer: a hash of the request cache's key fields (cache.ts cachedLlm). */
export const llmKey = (req: Pick<LlmRequest, 'system' | 'user' | 'schema' | 'schemaName' | 'effort'> & { name?: string }) =>
  createHash('sha256').update(stableStringify({ system: req.system, user: req.user, schema: req.schema, schemaName: req.schemaName ?? req.name, effort: req.effort })).digest('hex').slice(0, 16);
/** The audio a snippet request sends: the window widened to the grid (relisten.ts snapWindow). */
const snapped = (start: number, end: number, duration: number) => snapWindow(start, end, duration);

/** The refine LLM steps as no-ops: no corrections, no speaker labels, no styling. */
const NOOP_LLM: LlmProvider = {
  id: 'noop',
  async complete<T>(req: LlmRequest): Promise<T> {
    if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
    if (req.name === 'styling') return { styles: [] } as T;
    throw new Error(`regression gate: unexpected LLM request "${req.name}"`);
  },
};

export interface OvertoneRun {
  /** The output words (text, times, speaker, match kind). */
  words: SpeakerWord[];
  profiles: Profile[];
  retries: TimingRetry[];
  votes: TextVote[];
  /** Requests the current code made that the fixture has no answer for (answered with nothing / "keep"). */
  misses: { relisten: string[]; text: string[]; llm: string[] };
  /** The fixture's answers the run used; bench/gate-freeze.mjs keeps only these. */
  used: { relisten: Set<string>; text: Set<string>; llm: Set<string> };
}

export interface RunOptions {
  /** Answers requests the fixture lacks (bench/gate-freeze.mjs records them from live providers). */
  live?: {
    listen?: (provider: string, start: number, end: number) => Promise<BenchWord[]>;
    text?: (start: number, end: number, prompt: string | undefined) => Promise<string>;
    llm?: LlmProvider;
  };
  /** Engine choices (default: times from the second hearing when present, speakers by speakerEngine). */
  timeBy?: 'timing' | 'second';
  speakersBy?: 'timing' | 'second';
  /** Leave the second hearing (ElevenLabs) out, as without an ELEVENLABS_API_KEY. */
  noSecond?: boolean;
  /** Leave the text vote out. */
  noVote?: boolean;
  /** Leave the prompt echo guard out. */
  noEcho?: boolean;
}

export async function runOvertone(f: Fixture, opts: RunOptions = {}): Promise<OvertoneRun> {
  const log = memoryLogger();
  const misses: OvertoneRun['misses'] = { relisten: [], text: [], llm: [] };
  const used: OvertoneRun['used'] = { relisten: new Set(), text: new Set(), llm: new Set() };
  const language = f.language;
  const live = opts.live;

  // ---- the hearings
  // Look a window up as asked (older fixtures), then as sent on the grid; its words are relative to its start.
  const listener = (id: string) => async (start: number, end: number) => {
    const win = snapped(start, end, f.duration);
    const windows = f.relisten.windows[id];
    let at = start;
    let key = spanKey(start, end);
    let words = windows?.[key];
    if (!words) { at = win.start; key = spanKey(win.start, win.end); words = windows?.[key]; }
    if (!words && live?.listen) {
      words = (await live.listen(id, win.start, win.end)).map((w) => ({ ...w, start: roundTime(w.start - win.start), end: roundTime(w.end - win.start) }));
      (f.relisten.windows[id] ??= {})[spanKey(win.start, win.end)] = words;
    }
    if (!words) { misses.relisten.push(`${id} ${spanKey(win.start, win.end)}`); return []; }
    used.relisten.add(`${id} ${key}`);
    return words.map((w) => ({ ...w, start: roundTime(w.start + at), end: roundTime(w.end + at) }));
  };
  const second = opts.noSecond ? undefined : f.hearings.elevenlabs;
  const engines: EngineHearing[] = [
    { id: f.timing.provider, label: 'Azure Speech', words: f.timing.words, listen: listener(f.timing.provider) },
    ...(second ? [{ id: second.provider, label: 'ElevenLabs Scribe', words: second.words, listen: listener(second.provider) }] : []),
  ];

  // ---- the text base: an empty chunk takes its frozen retry; one still empty takes the engines' words
  const chunks = f.text.covered.map((c, k) => {
    // the prompt echo guard against the chunk's timing words, as in pipeline/text-base.ts
    const raw = f.text.raw[k] ?? '';
    const text = opts.noEcho ? raw : findPromptEcho(raw, f.text.prompt?.[k], f.timing.words.filter((w) => w.end > c.start && w.start < c.end), { language }).text;
    return { start: c.start, end: c.end, text };
  });
  const base = textBase(chunks.map((c, k) => ({ ...c, text: c.text.trim() ? c.text : (f.text.retry?.[k] ?? '') })), engines, { duration: f.duration });

  // ---- timing, snippet re-listens and the text vote
  const timeBy = second && (opts.timeBy ?? 'second') === 'second' ? 1 : 0;
  const speakersBy = opts.speakersBy === undefined ? speakerEngine(engines, timeBy) : second && opts.speakersBy === 'second' ? 1 : 0;
  const llm: LlmProvider = {
    id: 'frozen',
    async complete<T>(req: LlmRequest): Promise<T> {
      const key = llmKey(req);
      let answer = f.llm?.[key];
      if (answer === undefined && live?.llm) {
        answer = await live.llm.complete(req);
        (f.llm ??= {})[key] = answer;
      }
      if (answer === undefined) { misses.llm.push(`${req.name} ${key}`); return { spans: [] } as T; }
      used.llm.add(key);
      return answer as T;
    },
  };
  const relistenText = async (start: number, end: number, prompt: string | undefined) => {
    const win = snapped(start, end, f.duration);
    start = win.start;
    end = win.end;
    const key = textKey(start, end, prompt);
    let text = f.relistenText?.[key];
    if (text === undefined && live?.text) {
      text = await live.text(start, end, prompt);
      (f.relistenText ??= {})[key] = text;
    }
    if (text === undefined) { misses.text.push(key); return ''; }
    used.text.add(key);
    return text;
  };
  const heard = await hear({
    text: tokenizeDisplay(base.chunks.map((c) => c.text).join(' ')),
    engines, timeBy, speakersBy,
    ...(base.textIsEngine !== undefined ? { textIsEngine: base.textIsEngine } : {}),
    language, duration: f.duration,
    ...(f.context ? { context: f.context } : {}),
    ...(f.names ? { names: f.names } : {}),
  }, { log, ...(opts.noVote ? {} : { llm, relistenText }) });
  const turns = buildTurns(heard.words);

  // ---- refine without the LLM: the default profiles cut by the latest rule set
  const cfg = await resolveConfig({}, {}, { cwd: process.cwd(), configDir: process.cwd() });
  const res = await refine(NOOP_LLM, flattenTurns(turns), {
    glossary: [],
    effort: cfg.effort,
    llmLinebreaks: false,
    style: cfg.style,
    language,
    pinnedSpeakers: {},
    edits: cfg.edits,
    styling: cfg.styling,
    profiles: cfg.profiles,
    ruleset: LATEST_RULESET,
    duration: f.duration,
    heard: heard.words.map((w) => w.heard ?? null),
  }, log);
  return { words: res.words, profiles: res.profiles, retries: heard.retries, votes: heard.votes, misses, used };
}
