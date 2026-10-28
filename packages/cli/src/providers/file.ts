import { basename } from 'node:path';
import { UserError } from '../errors.js';
import { readTextInput } from '../recut.js';
import { detectSubtitleFormat, normalizeNewlines, parseSubtitles, subtitleText, type SubtitleFormat } from '../text/subtitles.js';
import type { AudioChunk, TextProvider, TextResult } from './types.js';

/** A `--text-file` transcript: its plain text and source format. */
export interface TextFile { path: string; format: SubtitleFormat | 'txt'; text: string; cues?: number }

/**
 * Reads a `--text-file`. SRT and WebVTT give their cue text without timing, speakers or markup; anything else is
 * plain text, minus Overtone-style speaker labels (`stripSpeakerLabels`). JSON, empty and binary files are errors.
 * `warn` is called when a non-UTF-8 file is read as Windows-1252.
 */
export async function readTranscriptFile(path: string, shown = path, warn?: (message: string) => void): Promise<TextFile> {
  const name = basename(path).toLowerCase();
  if (name.endsWith('.json')) throw new UserError(`--text-file ${shown}: expected a transcript (.srt, .vtt or .txt), not JSON. To re-cut an .overtone.json file, use "overtone recut".`);
  const content = normalizeNewlines(await readTextInput(path, shown, 'a transcript', warn));
  const format = detectSubtitleFormat(content, name);
  if (format) {
    const parsed = parseSubtitles(content, format);
    const text = subtitleText(parsed);
    if (!text.trim()) throw new UserError(`--text-file ${shown} has no cues with text.`);
    return { path, format, text, cues: parsed.cues.length };
  }
  const text = stripSpeakerLabels(content).replace(/\s+/g, ' ').trim();
  if (!text) throw new UserError(`--text-file ${shown} is empty.`);
  return { path, format: 'txt', text };
}

/** A speaker label at line start: "S1: …", "Maya: …", "Dr. Maya Chen: …". */
const LABEL = /^([^\s:][^:\n]{0,39}):[ \t]+\S/u;
/** A speaker id ("S1", "Speaker 2"): enough on its own to mark a one-paragraph transcript. */
const ID_LABEL = /^(?:S|Speaker )\d+$/u;

function isLabel(label: string): boolean {
  // a capital or caseless letter first (not "note", not "10" of "10:30"), at most 4 words
  return /^[\p{Lu}\p{Lt}\p{Lo}]/u.test(label) && label.trim().split(/\s+/).length <= 4 && !/[?!;]/.test(label);
}

/**
 * Drops speaker labels from a transcript shaped like Overtone's .txt export: one-line paragraphs starting with
 * "Label: ". Applies only when every paragraph has that shape (a single paragraph needs an id label such as "S1:"),
 * so ordinary text with one "Note: …" line is left alone. Expects normalized newlines.
 */
export function stripSpeakerLabels(content: string): string {
  const paragraphs = content.split(/\n[ \t]*\n/).map((p) => p.trim()).filter((p) => p !== '');
  if (paragraphs.length === 0) return content;
  const labels: string[] = [];
  for (const p of paragraphs) {
    const m = LABEL.exec(p);
    if (!m || p.includes('\n') || !isLabel(m[1])) return content;
    labels.push(m[1]);
  }
  if (paragraphs.length === 1 && !ID_LABEL.test(labels[0])) return content;
  return paragraphs.map((p, i) => p.slice(labels[i].length + 1).trim()).join('\n\n');
}

/** The text id for a --text-file run (`meta.models.text`, stage keys): "file:talk.srt". */
export const textFileId = (file: TextFile) => `file:${basename(file.path)}`;

/**
 * The text role for `--text-file`: returns the file's text, sends nothing. `input: 'wav'` makes the pipeline ask
 * once for the whole media. Not in the registry: chosen by --text-file, not --text.
 */
export class FileTextProvider implements TextProvider {
  readonly id: string;
  readonly input = 'wav' as const;
  /** Read fresh on every run. */
  readonly uncached = true;
  constructor(private readonly file: TextFile) {
    this.id = textFileId(file);
  }
  async transcribe(_audio: AudioChunk): Promise<TextResult> {
    return { text: this.file.text };
  }
}
