import { isUntimed } from '../align/align.js';
import type { Edit, Profile, Speaker, StyleSettings } from 'overtone-format';
import type { EffortConfig, ResolvedProfile } from '../config.js';
import type { Logger } from '../log.js';
import { isRefusal, type LlmProvider, type LlmRequest } from '../providers/types.js';
import type { RefusalSink } from '../refusals.js';
import { buildProfile, type CutDiagnostics } from '../segment/profile.js';
import type { RuleSet } from '../segment/rulesets/index.js';
import type { SpeakerWord } from '../turns.js';
import { applyEdits, type ProposedEdit, type RejectedEdit, type UnsureEdit } from './edits.js';
import { MAX_ROLE_CHARS, labelObjection, labelVouchers, roleObjection } from './labels.js';
import { correctionsPrompt, linebreaksPrompt, stylingPrompt, type Alternative, type PromptContext } from './prompts.js';
import { langOf } from '../lang/index.js';
import { normalizeText } from '../text/normalize.js';
import type { Heard } from '../types.js';
import {
  CORRECTIONS_SCHEMA,
  LINEBREAKS_SCHEMA,
  STYLING_SCHEMA,
  type CorrectionsResponse,
  type LinebreaksResponse,
  type StylingResponse,
} from './schemas.js';
import { applyStyles, enforceKeyPerCue, enforceStyleBudget, personName, unbrandPeople, type StyleSpan } from './styling.js';
import { planWindows, type Window } from './windows.js';

export interface RefineOptions {
  /** Told about a refused request; its window goes without that step. */
  onRefusal?: RefusalSink;
  /** The user's context: shown to the editor, and vouches for speaker labels whose words it has. */
  context?: string;
  /** A topic inferred from the transcript when the user gave none: shown like a context, but vouches for nothing. */
  inferredContext?: string;
  glossary: string[];
  /** Names and terms inferred from the transcript: unverified hints for the editor, never glossary terms or vouchers. */
  inferredTerms?: string[];
  /** Unset: the provider's default. */
  effort?: EffortConfig;
  /**
   * Ask the LLM where captions and lines break, per profile. Default true here; the CLI passes its own setting (off
   * unless --llm-linebreaks). false: every profile gets the rule-based layout alone.
   */
  llmLinebreaks?: boolean;
  style: StyleSettings;
  language: string;
  /** Labels pinned with --speakers; they win over LLM labels. */
  pinnedSpeakers: Record<string, string>;
  edits: { maxSpan: number };
  styling: { maxStyledRatio: number; maxKeyPerCue: number };
  profiles: ResolvedProfile[];
  /** For the line cutting and the pause marks in the prompts. Default: the latest. */
  ruleset?: RuleSet;
  duration: number;
  windowWords?: number;
  /** Per input word, what the timing side heard; shown to the editor where it differs from the transcript. */
  heard?: ReadonlyArray<Heard | null | undefined>;
}

export interface RefineResult {
  words: SpeakerWord[];
  speakers: Speaker[];
  edits: Edit[];
  rejected: RejectedEdit[];
  /** Applied edits the editor was not sure about, for the review list. */
  unsure: UnsureEdit[];
  /** LLM speaker labels the code rejected; the speaker keeps its role or id. */
  rejectedLabels: RejectedLabel[];
  /** LLM speaker roles rejected because they name someone; the role is dropped. */
  rejectedRoles: RejectedRole[];
  profiles: Profile[];
  /**
   * Line cutting per profile: speaker blocks, blocks cut entirely as proposed, cues from the proposal and cues the
   * rules cut instead. `rules`: no proposal was asked for, so the rules cut every cue.
   */
  cutting: Array<{ profile: string; blocks: number; fromProposal: number; proposalCues: number; repairedCues: number; rules?: true }>;
}

/** At most this many styling and line-cutting requests run at the same time. */
export const REFINE_CONCURRENCY = 3;

/**
 * Run `tasks` at most `limit` at a time, in order, keeping their order in the result. Task i starts no earlier than
 * `delays[i]` ms after the call (prompt caching: LlmProvider.cacheWarmupMs). After the first failure no new task starts
 * (each is a paid request); running ones are awaited, then the first error is thrown.
 */
export async function runLimited<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number, delays: readonly number[] = []): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  const t0 = Date.now();
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < tasks.length) {
      const i = next++;
      const wait = t0 + (delays[i] ?? 0) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (failure) return;
      try {
        results[i] = await tasks[i]!();
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  if (failure) throw failure.error;
  return results;
}

/**
 * Window `w` applies a range when `w` owns its first word and showed its last, so exactly one window applies a range
 * that crosses an ownership boundary.
 */
const owns = (w: Window, first: number, last: number) => first >= w.ownFirst && first <= w.ownLast && last <= w.last;

function speakerOrder(words: readonly SpeakerWord[]): string[] {
  return [...new Set(words.map((w) => w.speaker))];
}

/** An empty label or a bare slot name ("S1", "Speaker 3"): the model kept the id. */
function isIdLike(label: string, id: string): boolean {
  return label === '' || label.toLowerCase() === id.toLowerCase() || /^speaker\s*\d+$/i.test(label) || /^s\d+$/i.test(label);
}

/** Shorten text for a log line. */
function clip(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Debug lines for one profile: why proposed cues were rejected, per rule, with examples. */
export function describeCutting(profile: string, kept: number, d: CutDiagnostics): string[] {
  const reasons = Object.entries(d.rejected).sort((a, b) => b[1] - a[1]);
  const summary = reasons.map(([r, n]) => `${r} ${n}`).join(', ') || 'none';
  const out = [`${profile}: ${kept}/${d.proposed} proposed cues used; rejected by rule: ${summary}; blocks cut deterministically for reading speed: ${d.timingFallback}`];
  for (const [r] of reasons) for (const e of d.examples[r as keyof CutDiagnostics['examples']] ?? []) out.push(`  ${r}: "${clip(e.cue, 100)}" (${clip(e.detail, 60)})`);
  if (d.reflowed > 0) out.push(`  lines re-cut in ${d.reflowed} kept cue${d.reflowed === 1 ? '' : 's'}`);
  for (const e of d.reflowExamples) out.push(`  re-cut lines: "${clip(e.cue, 60)}" → "${clip(e.to, 60)}"`);
  for (const f of d.fallbacks) out.push(`  reading speed: block "${clip(f.block, 40)} …": ${f.mixed.toFixed(2)} s of reading time missing with the proposal, ${f.deterministic.toFixed(2)} s without`);
  return out;
}

/** An LLM speaker label the code rejected (labels.ts `labelObjection`). */
export interface RejectedLabel { id: string; label: string; why: string }
/** An LLM speaker role the code rejected (labels.ts `roleObjection`). */
export interface RejectedRole { id: string; role: string; why: string }

/**
 * One window's answer to a refine step, or undefined when the provider refused it (reported to `onRefusal` with
 * `without`, what the window goes without). Other errors fail the step.
 */
async function windowAnswer<T>(llm: LlmProvider, req: LlmRequest, words: readonly SpeakerWord[], win: Window, onRefusal: RefusalSink | undefined, without: string): Promise<T | undefined> {
  try {
    return await llm.complete<T>(req);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    const start = words[win.ownFirst]?.start ?? 0;
    onRefusal?.({ provider: err.provider, by: err.by, request: `the ${req.name} request (words ${win.ownFirst}–${win.ownLast})`, start, end: words[win.ownLast]?.end ?? start, instead: without });
    return undefined;
  }
}

/**
 * Where the timing side heard something other than the transcript: one entry per heard range (consecutive words that
 * share it) that differs after normalization. Words it did not hear are left out (the prompt marks them with *).
 */
export function alternativesOf(words: readonly SpeakerWord[], heard: RefineOptions['heard'], language: string): Alternative[] {
  if (!heard) return [];
  const lang = langOf(language);
  const out: Alternative[] = [];
  for (let i = 0; i < words.length; ) {
    const h = heard[i];
    if (!h) { i++; continue; }
    let j = i;
    while (j + 1 < words.length && heard[j + 1] && heard[j + 1]!.first === h.first && heard[j + 1]!.last === h.last) j++;
    const said = words.slice(i, j + 1).map((w) => w.text).join(' ');
    if (normalizeText(said, lang) !== normalizeText(h.text, lang)) out.push({ first: i, last: j, heard: h.text });
    i = j + 1;
  }
  return out;
}

/**
 * 5a: corrections and speaker labels. A label is kept only when the transcript, the user's context or the glossary
 * has its words. A role is dropped when it is too long or names someone, and only a kept role vouches for a label that
 * repeats it. Labels pinned with --speakers are not checked; their roles are.
 */
async function corrections(llm: LlmProvider, words: SpeakerWord[], opts: RefineOptions, p: PromptContext) {
  const proposed: ProposedEdit[] = [];
  const alternatives = alternativesOf(words, opts.heard, opts.language);
  const labels = new Map<string, string>();
  const roles = new Map<string, string>();
  for (const win of planWindows(words, opts.windowWords)) {
    const ids = speakerOrder(words.slice(win.first, win.last + 1));
    const prompt = correctionsPrompt(p, words, win, ids, alternatives);
    const res = await windowAnswer<CorrectionsResponse>(llm, { name: 'corrections', ...prompt, schema: CORRECTIONS_SCHEMA, effort: opts.effort?.corrections }, words, win, opts.onRefusal,
      'went on without corrections or speaker names there');
    if (!res) continue;
    proposed.push(...res.edits.filter((e) => owns(win, e.first, e.last)));
    // the first real label and the first non-empty role per id win
    for (const s of res.speakers) {
      const label = s.label.trim();
      const role = s.role.trim();
      if (!isIdLike(label, s.id) && !labels.has(s.id)) labels.set(s.id, label);
      if (role && role.length <= MAX_ROLE_CHARS && !roles.has(s.id)) roles.set(s.id, role);
    }
  }
  const result = applyEdits(words, proposed, { maxSpan: opts.edits.maxSpan, language: opts.language });
  const known = labelVouchers([...words, ...result.words].map((w) => w.text).concat(opts.context ?? ''), opts.glossary, opts.language);
  const rejectedLabels: RejectedLabel[] = [];
  const rejectedRoles: RejectedRole[] = [];
  const speakers: Speaker[] = speakerOrder(result.words).map((id) => {
    let role = roles.get(id);
    const roleWhy = role === undefined ? null : roleObjection(role, known, opts.language);
    if (role !== undefined && roleWhy) {
      rejectedRoles.push({ id, role, why: roleWhy });
      role = undefined;
    }
    let label = opts.pinnedSpeakers[id];
    const proposedLabel = labels.get(id);
    if (label === undefined && proposedLabel !== undefined) {
      const why = labelObjection(proposedLabel, role ?? '', known, opts.language);
      if (why) rejectedLabels.push({ id, label: proposedLabel, why });
      else label = proposedLabel;
    }
    return { id, ...(label ? { label } : {}), ...(role ? { role } : {}) };
  });
  return { ...result, speakers, rejectedLabels, rejectedRoles };
}

/** 5b: semantic classes (never "brand" on the speakers' names), then the budget. */
async function styling(llm: LlmProvider, words: SpeakerWord[], opts: RefineOptions, p: PromptContext, people: readonly string[]): Promise<void> {
  const spans: StyleSpan[] = [];
  for (const win of planWindows(words, opts.windowWords)) {
    const res = await windowAnswer<StylingResponse>(llm, { name: 'styling', ...stylingPrompt(p, words, win, people), schema: STYLING_SCHEMA, effort: opts.effort?.styling }, words, win, opts.onRefusal,
      'went on without styling there');
    if (!res) continue;
    spans.push(...res.styles.filter((s) => owns(win, s.first, s.last)));
  }
  applyStyles(words, spans);
  unbrandPeople(words, people);
  enforceStyleBudget(words, opts.styling.maxStyledRatio);
}

/** 5c: line-cutting proposals for one profile, merged over windows. Undefined on a refusal: the rules cut alone. */
async function linebreaks(llm: LlmProvider, words: SpeakerWord[], spec: ResolvedProfile, opts: RefineOptions, p: PromptContext): Promise<LinebreaksResponse | undefined> {
  const merged: LinebreaksResponse = { cueStarts: [], lineStarts: [] };
  for (const win of planWindows(words, opts.windowWords)) {
    // one schema name for every profile, so their requests share a prompt prefix (prompt caching)
    const res = await windowAnswer<LinebreaksResponse>(llm, { name: `linebreaks-${spec.id}`, schemaName: 'linebreaks', ...linebreaksPrompt(p, words, win, spec), schema: LINEBREAKS_SCHEMA, effort: opts.effort?.linebreaks }, words, win, opts.onRefusal,
      `cut the lines of ${spec.id} by the rules alone`);
    if (!res) return undefined;
    // the prompt says the first owned word starts a caption; keep that true where windows meet
    if (win.ownFirst > 0) merged.cueStarts.push(win.ownFirst);
    merged.cueStarts.push(...res.cueStarts.filter((i) => owns(win, i, i)));
    merged.lineStarts.push(...res.lineStarts.filter((i) => owns(win, i, i)));
  }
  return merged;
}

/**
 * The refine stage: corrections and speakers, then styling and per-profile line cutting concurrently (both read only
 * the corrected text; line cutting never reads classes). The key-phrase limit per cue needs both, so it runs last.
 */
export async function refine(llm: LlmProvider, input: readonly SpeakerWord[], opts: RefineOptions, log: Logger): Promise<RefineResult> {
  const p: PromptContext = {
    context: opts.context ?? opts.inferredContext,
    glossary: opts.glossary,
    ...(opts.inferredTerms && opts.inferredTerms.length > 0 ? { inferredTerms: opts.inferredTerms } : {}),
    style: opts.style,
    language: opts.language,
    maxSpan: opts.edits.maxSpan,
    maxStyledRatio: opts.styling.maxStyledRatio,
    ...(opts.ruleset ? { ruleset: opts.ruleset } : {}),
  };
  const fixed = await corrections(llm, input.map((w) => ({ ...w })), opts, p);
  for (const r of fixed.rejected) log.warn(`rejected edit [${r.edit.first}, ${r.edit.last}] "${clip(r.from)}" → "${clip(r.edit.to)}" (${r.edit.reason}): ${r.why}`);
  for (const r of fixed.rejectedLabels) log.warn(`rejected speaker label ${r.id} "${clip(r.label)}": ${r.why}`);
  for (const r of fixed.rejectedRoles) log.warn(`rejected speaker role ${r.id} "${clip(r.role)}": ${r.why}`);
  const words = fixed.words;
  // words no engine heard have an unknown time, so the line cutter sees no pause next to them
  const untimed = words.map(isUntimed);
  // speakers labeled with a personal name: 5b must never mark them as "brand"
  const people = fixed.speakers.flatMap((s) => (s.label && !isIdLike(s.label, s.id) && personName(s.label) ? [s.label.replace(/\s*\([^)]*\)/g, '').trim()] : []));
  // Styling and the first profile start at once. The other profiles share the first one's prompt prefix and start a
  // cache warm-up apart; styling's schema differs, so it shares no cache.
  const warmup = llm.cacheWarmupMs ?? 0;
  const useLlm = opts.llmLinebreaks !== false;
  const cutters = useLlm ? opts.profiles : [];
  const proposals = await runLimited<LinebreaksResponse | undefined>([
    async () => { await styling(llm, words, opts, p, people); return undefined; },
    ...cutters.map((spec) => () => linebreaks(llm, words, spec, opts, p)),
  ], REFINE_CONCURRENCY, [0, ...cutters.map((_, k) => k * warmup)]);
  const profiles: Profile[] = [];
  const cutting: RefineResult['cutting'] = [];
  for (const [k, spec] of opts.profiles.entries()) {
    const proposal = useLlm ? proposals[k + 1] : undefined;
    const built = buildProfile(words, spec, { language: opts.language, glossary: opts.glossary, duration: opts.duration, untimed, ...(proposal ? { proposal } : {}), ...(opts.ruleset ? { ruleset: opts.ruleset } : {}) });
    profiles.push(built.profile);
    cutting.push({ profile: spec.id, blocks: built.blocks, fromProposal: built.fromProposal, proposalCues: built.proposalCues, repairedCues: built.repairedCues, ...(useLlm ? {} : { rules: true as const }) });
    if (useLlm) for (const line of describeCutting(spec.id, built.proposalCues, built.diagnostics)) log.debug(line);
  }
  enforceKeyPerCue(words, profiles, opts.styling.maxKeyPerCue);
  return { words, speakers: fixed.speakers, edits: fixed.edits, rejected: fixed.rejected, unsure: fixed.unsure, rejectedLabels: fixed.rejectedLabels, rejectedRoles: fixed.rejectedRoles, profiles, cutting };
}
