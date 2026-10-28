import type { Speaker } from 'overtone-format';

/**
 * Reading existing subtitles (SubRip and WebVTT) for `overtone recut` and `transcribe --text-file`.
 *
 * Cue text is cleaned to plain spoken text: tags (`<i>`, `<font …>`, `<c.x>`, `<b>`, inline timestamps), SSA
 * overrides (`{\an8}`) and ruby annotations are removed, HTML entities decoded and whitespace collapsed.
 *
 * Speakers, conservatively, from the first source the file uses:
 * 1. WebVTT voice tags (`<v Sarah>`);
 * 2. "NAME:" prefixes at the start of a line: an all-caps name ("SARAH:", "DR. LEE:") always counts; a capitalized
 *    name ("Sarah:") only when at least two different names each start at least two lines (so a single
 *    "Note: …" stays text);
 * 3. dialogue dashes: in a cue with at least two lines starting with "-", the dashes are removed and each dashed
 *    line after the file's first one switches between two unnamed speakers (a two-person exchange is assumed);
 * 4. none of these: one speaker.
 * A line without its own speaker continues the previous one.
 */

export type SubtitleFormat = 'srt' | 'vtt';

/** A run of cue text by one speaker (speaker ids are "S1", "S2", … in order of appearance). */
export interface SubtitleSegment { speaker: string; text: string }
export interface SubtitleCue { start: number; end: number; segments: SubtitleSegment[] }
export type SpeakerSource = 'voice tags' | 'name prefixes' | 'dialogue dashes' | 'none';
export interface ParsedSubtitles {
  format: SubtitleFormat;
  cues: SubtitleCue[];
  speakers: Speaker[];
  speakerSource: SpeakerSource;
  /** Blocks that looked like cues but had an unreadable timing line, or cues without text. */
  skipped: number;
}

/** BOM removed, line endings normalized to "\n". */
export function normalizeNewlines(content: string): string {
  return content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/;

/** "01:02:03,500" / "02:03.5" / "1:02:03.500" → seconds, or undefined. */
export function parseTimestamp(value: string): number | undefined {
  const m = TIMESTAMP.exec(value.trim());
  if (!m) return undefined;
  const [, h, min, s, frac] = m;
  if (Number(s) > 59 || (h !== undefined && Number(min) > 59)) return undefined;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0);
}

const TIMING_LINE = /^\s*(\S+)\s+-->\s+(\S+)/;

/** Which subtitle format the content is, from the file name first, then the content; undefined when neither. */
export function detectSubtitleFormat(content: string, fileName = ''): SubtitleFormat | undefined {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'srt' || ext === 'vtt') return ext;
  const text = normalizeNewlines(content);
  if (/^WEBVTT(?:[ \t]|$)/m.test(text.slice(0, 64))) return 'vtt';
  const timing = text.split('\n').find((l) => l.includes('-->'));
  if (timing) {
    const m = TIMING_LINE.exec(timing);
    if (m && parseTimestamp(m[1]) !== undefined && parseTimestamp(m[2]) !== undefined) return /,\d/.test(m[1]) ? 'srt' : 'vtt';
  }
  return undefined;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '', hellip: '…', ndash: '–', mdash: '—' };

/** Decode the HTML entities subtitle files use (named ones above and numeric ones); unknown ones stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const name = body.toLowerCase();
    // own names only: "&constructor;" is no entity, not Object's constructor
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : whole;
  });
}

/** A line of cue text with the voice (`<v Name>`) it belongs to, if any. */
interface RawLine { text: string; voice?: string }

const VOICE = /<v(?:\.[^\s>]*)?(?:\s+([^>]*))?>/gi;
/** Markup tags (`<i>`, `</font>`, `<c.key>`) and inline timestamps (`<00:01.500>`); not "a < b". */
const TAG = /<\/?(?:[a-z][^<>]*|\d[\d:.]*)>/gi;

/** Remove markup from one piece of cue text (voice tags already taken out). */
function stripMarkup(text: string): string {
  return decodeEntities(
    text
      .replace(/<rt>[\s\S]*?<\/rt>/gi, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(TAG, ''),
  ).replace(/[‎‏]/g, '');
}

/** Split cue text into lines, each with its voice; a voice tag inside a line starts a new line. */
function cueLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  let voice: string | undefined;
  let last = 0;
  const push = (piece: string) => {
    // the text after a voice tag belongs to it, up to the next voice tag (later lines too)
    for (const line of piece.split('\n')) {
      const clean = stripMarkup(line).replace(/\s+/g, ' ').trim();
      if (clean) out.push({ text: clean, ...(voice ? { voice } : {}) });
    }
  };
  for (const m of text.matchAll(VOICE)) {
    push(text.slice(last, m.index));
    const name = decodeEntities(m[1] ?? '').replace(/\s+/g, ' ').trim();
    voice = name || voice;
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

interface RawCue { start: number; end: number; lines: RawLine[] }

/** The cue blocks of a file: timing plus raw lines (no speaker inference yet). */
function readCues(content: string, format: SubtitleFormat): { cues: RawCue[]; skipped: number } {
  const blocks = normalizeNewlines(content).split(/\n[ \t]*\n/);
  const cues: RawCue[] = [];
  let skipped = 0;
  for (const [b, block] of blocks.entries()) {
    const lines = block.split('\n');
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    if (lines.length === 0) continue;
    if (format === 'vtt') {
      const head = lines[0].trim();
      if (b === 0 && /^WEBVTT(?:\s|$)/.test(head)) continue;
      if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(head)) continue;
    }
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0 || at > 1) {
      // SRT: a lone number or text without timing; VTT: the header's continuation. Count text blocks only.
      if (lines.some((l) => /[\p{L}\p{N}]/u.test(l)) && !(at < 0 && lines.length === 1 && /^\d+$/.test(lines[0].trim()))) skipped++;
      continue;
    }
    let rest = lines.slice(at);
    while (rest.length > 0) {
      const timing = timingOf(rest[0]);
      if (!timing) { skipped++; break; }
      // a later timing line starts the next cue (a file without the blank line between cues), its number with it
      const next = rest.findIndex((l, k) => k > 0 && timingOf(l) !== undefined);
      const cut = next < 0 ? rest.length : /^\s*\d+\s*$/.test(rest[next - 1]) && next > 1 ? next - 1 : next;
      const text = cueLines(rest.slice(1, cut).join('\n'));
      if (text.length === 0) skipped++;
      else cues.push({ ...timing, lines: text });
      rest = next < 0 ? [] : rest.slice(next);
    }
  }
  return { cues, skipped };
}

/** The start and end of a timing line ("00:00:01,000 --> 00:00:03,000"); undefined when it is none or unreadable. */
function timingOf(line: string): { start: number; end: number } | undefined {
  const m = TIMING_LINE.exec(line);
  const start = m ? parseTimestamp(m[1]) : undefined;
  const end = m ? parseTimestamp(m[2]) : undefined;
  return start === undefined || end === undefined ? undefined : { start, end };
}

const DASH = /^[-–—]\s*(?=\S)/;
const CAPS_NAME = /^((?:\p{Lu}[\p{Lu}\p{N}.'’&-]*)(?: \p{Lu}[\p{Lu}\p{N}.'’&-]*){0,3}):\s+(\S.*)$/u;
const TITLE_NAME = /^(\p{Lu}[\p{Ll}.'’-]+(?: \p{Lu}[\p{Ll}.'’-]+){0,2}):\s+(\S.*)$/u;

/** A "NAME: text" line → name and text (all-caps names need at least two letters). */
function capsPrefix(line: string): { name: string; text: string } | undefined {
  const m = CAPS_NAME.exec(line.replace(DASH, ''));
  if (!m || (m[1].match(/\p{L}/gu)?.length ?? 0) < 2) return undefined;
  return { name: m[1], text: m[2] };
}
function titlePrefix(line: string): { name: string; text: string } | undefined {
  const m = TITLE_NAME.exec(line.replace(DASH, ''));
  return m ? { name: m[1], text: m[2] } : undefined;
}

/** Is this cue a dialogue: at least two of its lines start with a dash? */
const isDialogue = (cue: RawCue) => cue.lines.filter((l) => DASH.test(l.text)).length >= 2;

/** Parse SubRip or WebVTT content (see the module comment for the speaker rules). */
export function parseSubtitles(content: string, format: SubtitleFormat): ParsedSubtitles {
  const { cues: raw, skipped } = readCues(content, format);
  const allLines = raw.flatMap((c) => c.lines);

  // which speaker source the file uses
  const titleCounts = new Map<string, number>();
  for (const l of allLines) {
    const t = titlePrefix(l.text);
    if (t) titleCounts.set(t.name, (titleCounts.get(t.name) ?? 0) + 1);
  }
  const titleNames = new Set([...titleCounts].filter(([, n]) => n >= 2).map(([name]) => name));
  const useTitle = titleNames.size >= 2;
  const namePrefix = (line: string) => {
    const caps = capsPrefix(line);
    if (caps) return caps;
    const title = useTitle ? titlePrefix(line) : undefined;
    return title && titleNames.has(title.name) ? title : undefined;
  };
  const source: SpeakerSource = allLines.some((l) => l.voice)
    ? 'voice tags'
    : allLines.some((l) => namePrefix(l.text))
      ? 'name prefixes'
      : raw.some(isDialogue)
        ? 'dialogue dashes'
        : 'none';

  // speaker keys → ids in order of appearance; the label is the first spelling of a name
  const ids = new Map<string, Speaker>();
  const idOf = (key: string, label?: string): string => {
    let s = ids.get(key);
    if (!s) {
      s = { id: `S${ids.size + 1}`, ...(label ? { label } : {}) };
      ids.set(key, s);
    }
    return s.id;
  };

  // the current speaker's key (upper-cased name; '' unknown; '#1'/'#2' the two unnamed dialogue speakers)
  let current = source === 'dialogue dashes' ? '#1' : '';
  let label: string | undefined;
  let dashSeen = false;
  const cues: SubtitleCue[] = [];
  for (const cue of raw) {
    const dialogue = isDialogue(cue);
    const segments: SubtitleSegment[] = [];
    for (const line of cue.lines) {
      let text = line.text;
      if (source === 'voice tags') {
        if (line.voice) { current = line.voice.toLocaleUpperCase(); label = line.voice; }
      } else if (source === 'name prefixes') {
        const p = namePrefix(text);
        if (p) { current = p.name.toLocaleUpperCase(); label = p.name; text = p.text; }
      } else if (source === 'dialogue dashes' && dialogue && DASH.test(text)) {
        // the first dialogue line continues the speaker before it; every later one switches
        if (dashSeen) current = current === '#2' ? '#1' : '#2';
        dashSeen = true;
      }
      if (dialogue) text = text.replace(DASH, '');
      const speaker = idOf(current, current === '' || current.startsWith('#') ? undefined : label);
      const prev = segments.at(-1);
      if (prev && prev.speaker === speaker) prev.text = `${prev.text} ${text}`;
      else segments.push({ speaker, text });
    }
    cues.push({ start: cue.start, end: cue.end, segments });
  }
  return { format, cues, speakers: [...ids.values()], speakerSource: source, skipped };
}

/** The spoken text of parsed subtitles: every cue's text in order, speaker names and markup removed. */
export function subtitleText(parsed: ParsedSubtitles): string {
  return parsed.cues.flatMap((c) => c.segments.map((s) => s.text)).join(' ');
}
