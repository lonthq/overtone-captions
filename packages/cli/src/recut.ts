import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { assertValid, FORMAT_NAME, FORMAT_VERSION, roundTime, type OvertoneDocument, type Profile, type Speaker, type Turn } from 'overtone-format';
import type { ResolvedProfile } from './config.js';
import { assertDocument } from './document.js';
import { UserError, fsCode } from './errors.js';
import { enforceKeyPerCue } from './refine/styling.js';
import { buildProfile } from './segment/profile.js';
import { LATEST_RULESET, layoutMeta, type RuleSet } from './segment/rulesets/index.js';
import { decodeText } from './text/decode.js';
import { tokenizeDisplay } from './text/normalize.js';
import { detectSubtitleFormat, normalizeNewlines, parseSubtitles, type ParsedSubtitles, type SubtitleCue, type SubtitleFormat } from './text/subtitles.js';
import { endsSentence, flattenTurns, groupTurns, type SpeakerWord } from './turns.js';

/** Larger files are not subtitle or text files; refuse them before reading them into memory. */
export const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024;

/** `meta.timing` of a document whose word times were estimated from cue times. */
export const ESTIMATED_TIMING = 'estimated-from-cues';

/**
 * Read a text file; fs errors, oversized and binary files become one-line user errors naming `shown`. UTF-8 and UTF-16
 * (with BOM) are read as is; invalid UTF-8 is read as Windows-1252, with a `warn`.
 */
export async function readTextInput(path: string, shown: string, what: string, warn?: (message: string) => void): Promise<string> {
  let raw: Buffer;
  try {
    const info = await stat(path);
    if (info.isDirectory()) throw new UserError(`${shown} is a directory, not ${what}.`);
    if (info.size > MAX_TEXT_FILE_BYTES) throw new UserError(`${shown} is ${Math.round(info.size / 1024 / 1024)} MB; ${what} is at most ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB. Is it a media file?`);
    raw = await readFile(path);
  } catch (err) {
    if (err instanceof UserError) throw err;
    const code = fsCode(err);
    if (code === 'ENOENT') throw new UserError(`File not found: ${shown}`);
    if (code === 'EACCES' || code === 'EPERM') throw new UserError(`${shown} is not readable (permission denied).`);
    throw new UserError(`Cannot read ${shown} (${code ?? (err as Error).message})`);
  }
  const decoded = decodeText(raw);
  if (!decoded) throw new UserError(`${shown} is not a text file (it looks binary). Is it a media file?`);
  if (decoded.encoding === 'windows-1252') warn?.(`${shown} is not valid UTF-8; read it as Windows-1252 (Western European). If characters look wrong, save the file as UTF-8.`);
  return decoded.text;
}

/**
 * Word times estimated from cue times: each cue's span is spread over its words by length (letters and digits, at
 * least 1), contiguous inside a cue; gaps between cues stay pauses. A cue starting before the previous one ended
 * starts at that end. Whole milliseconds. Every word gets `match: "interpolated"` and confidence 0: no audio was
 * aligned.
 */
export function estimateWordTimes(cues: readonly SubtitleCue[]): SpeakerWord[] {
  const out: SpeakerWord[] = [];
  let after = 0; // ms
  for (const { cue, words } of cueWords(cues)) {
    const start = Math.max(Math.round(cue.start * 1000), after);
    // a cue without length gets 1 ms per word, so word times stay ordered
    const end = Math.max(Math.round(cue.end * 1000), start + words.length);
    const weights = words.map((w) => Math.max(1, w.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0));
    const total = weights.reduce((a, b) => a + b, 0);
    let sum = 0;
    const edges = [start, ...weights.map((w) => { sum += w; return start + Math.round(((end - start) * sum) / total); })];
    words.forEach((w, i) => out.push({ text: w.text, start: edges[i] / 1000, end: edges[i + 1] / 1000, match: 'interpolated', confidence: 0, speaker: w.speaker }));
    after = end;
  }
  return out;
}

/** The cues by start time, each with its words; cues without words are left out. */
function cueWords(cues: readonly SubtitleCue[]): Array<{ cue: SubtitleCue; words: Array<{ text: string; speaker: string }> }> {
  return [...cues]
    .sort((a, b) => a.start - b.start)
    .map((cue) => ({ cue, words: cue.segments.flatMap((s) => tokenizeDisplay(s.text).map((text) => ({ text, speaker: s.speaker }))) }))
    .filter((c) => c.words.length > 0);
}

/** A broken-off word ("could-", "by—"): the speaker may have been cut off. */
const CUT_OFF = /[-‐–—]["'”’»)\]]*$/u;
/** A cue opening with an ellipsis ("...but") continues the previous cue's sentence. */
const CONTINUES = /^["'“‘«(\[]*(?:\.{2,}|…)/u;

/**
 * Where the speaker may change in subtitles that do not name speakers: at the end of a cue whose last word ends a
 * sentence or breaks off, unless the next cue opens with an ellipsis. Per word of `estimateWordTimes(parsed.cues)`;
 * undefined when the file names its speakers. The line cutter treats each mark as a speaker change, so no caption joins
 * two people's lines; the document keeps the file's speakers.
 */
export function possibleSpeakerChanges(parsed: ParsedSubtitles): boolean[] | undefined {
  if (parsed.speakerSource === 'voice tags' || parsed.speakerSource === 'name prefixes') return undefined;
  const words = cueWords(parsed.cues).flatMap((c) => c.words.map((w, i) => ({ text: w.text, cueEnd: i === c.words.length - 1 })));
  return words.map((w, i) => {
    const next = words[i + 1]?.text;
    if (!w.cueEnd || next === undefined || CONTINUES.test(next)) return false;
    return CUT_OFF.test(w.text) || endsSentence(w.text, { prev: words[i - 1]?.text, next });
  });
}

/** What `overtone recut` reads: subtitles (cue times) or an Overtone document (word times). */
export type RecutSource =
  | { kind: SubtitleFormat; parsed: ParsedSubtitles }
  | { kind: 'overtone'; doc: OvertoneDocument };

/** Read and parse the input of `overtone recut`: SRT, WebVTT or an .overtone.json document. */
export async function readRecutSource(path: string, shown: string, warn?: (message: string) => void): Promise<RecutSource> {
  const name = basename(path).toLowerCase();
  const content = await readTextInput(path, shown, 'a subtitle file', warn);
  const text = normalizeNewlines(content);
  if (name.endsWith('.json') || /^\s*\{/.test(text)) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new UserError(`${shown}: not valid JSON (${(err as Error).message})`);
    }
    return { kind: 'overtone', doc: assertDocument(value, shown) };
  }
  if (!text.trim()) throw new UserError(`${shown} is empty.`);
  const format = detectSubtitleFormat(text, name);
  if (!format) {
    throw new UserError(`${shown} is not a subtitle file recut can read: expected SubRip (.srt), WebVTT (.vtt) or an .overtone.json document. Plain text has no timing: to time it against the media, use "overtone transcribe <media> --text-file ${basename(path)}".`);
  }
  const parsed = parseSubtitles(text, format);
  if (parsed.cues.length === 0) throw new UserError(`${shown} has no cues with text (read as ${format === 'srt' ? 'SubRip' : 'WebVTT'}).`);
  return { kind: format, parsed };
}

export interface RecutOptions {
  /** For the language pack's line-break rules ("und" when unknown). */
  language: string;
  profiles: readonly ResolvedProfile[];
  glossary: readonly string[];
  /** Labels pinned with --speakers; they win over the file's names. */
  pinnedSpeakers: Record<string, string>;
  /** Most `key` phrases per cue (styling.maxKeyPerCue), for documents with classes. */
  maxKeyPerCue: number;
  /** Default: the latest. Recorded as meta.rules. */
  ruleset?: RuleSet;
  generator: string;
  createdAt: string;
}

/** Profiles cut by the rules (the `transcribe` default); no cue spans a word marked in `speakerMayChange`. */
function cutProfiles(words: readonly SpeakerWord[], opts: RecutOptions, duration: number, speakerMayChange?: readonly boolean[]): Profile[] {
  const ruleset = opts.ruleset ?? LATEST_RULESET;
  return opts.profiles.map((spec) => buildProfile(words, spec, { language: opts.language, glossary: opts.glossary, duration, ruleset, ...(speakerMayChange ? { speakerMayChange } : {}) }).profile);
}

const pin = (speakers: readonly Speaker[], pinned: Record<string, string>): Speaker[] =>
  speakers.map((s) => (Object.hasOwn(pinned, s.id) ? { ...s, label: pinned[s.id] } : s));

/**
 * A new document with the requested profiles cut by the rules. From subtitles: words timed by `estimateWordTimes`,
 * turns from the file's speakers, no cue across a `possibleSpeakerChanges` mark, `meta.timing` ESTIMATED_TIMING. From
 * an Overtone document: words, turns, speakers, edits, classes and meta are kept (at most `maxKeyPerCue` key phrases
 * per new cue); only the profiles are replaced.
 */
export function recutDocument(source: RecutSource, opts: RecutOptions): OvertoneDocument {
  const meta = { linebreaks: 'rules', ...layoutMeta(opts.ruleset ?? LATEST_RULESET, opts.language), generator: opts.generator, createdAt: opts.createdAt };
  if (source.kind === 'overtone') {
    const doc = source.doc;
    const words = flattenTurns(doc.turns);
    const profiles = cutProfiles(words, opts, doc.duration);
    enforceKeyPerCue(words, profiles, opts.maxKeyPerCue);
    let i = 0;
    const turns: Turn[] = doc.turns.map((t) => ({
      ...t,
      words: t.words.map(({ classes: _old, ...w }) => {
        const classes = words[i++].classes;
        return classes && classes.length > 0 ? { ...w, classes } : w;
      }),
    }));
    return assertValid({
      ...doc,
      language: opts.language,
      speakers: pin(doc.speakers, opts.pinnedSpeakers),
      turns,
      profiles,
      meta: { ...doc.meta, ...meta },
    } satisfies OvertoneDocument);
  }
  const words = estimateWordTimes(source.parsed.cues);
  if (words.length === 0) throw new UserError('The subtitles have no words to cut (only punctuation or symbols).');
  const duration = roundTime(words.at(-1)?.end ?? 0);
  const used = new Set(words.map((w) => w.speaker));
  return assertValid({
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    language: opts.language,
    duration,
    speakers: pin(source.parsed.speakers.filter((s) => used.has(s.id)), opts.pinnedSpeakers),
    turns: groupTurns(words),
    profiles: cutProfiles(words, opts, duration, possibleSpeakerChanges(source.parsed)),
    meta: { source: source.kind, timing: ESTIMATED_TIMING, ...meta },
  } satisfies OvertoneDocument);
}
