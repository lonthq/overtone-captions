export const FORMAT_NAME = 'overtone' as const;
export const FORMAT_VERSION = 1 as const;

export const STYLE_CLASSES = ['emphasis', 'key', 'brand', 'number', 'soft'] as const;
export type StyleClass = (typeof STYLE_CLASSES)[number];

export const MATCH_KINDS = ['exact', 'fuzzy', 'split', 'merge', 'interpolated', 'edited'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

export const EDIT_REASONS = ['correction', 'brand', 'style', 'punctuation', 'split-word'] as const;
export type EditReason = (typeof EDIT_REASONS)[number];

/** Inclusive [first, last] global word indices. */
export type WordRange = [number, number];

export interface Word {
  text: string;          // display text incl. punctuation
  start: number;         // seconds
  end: number;           // seconds
  classes?: StyleClass[];
  match?: MatchKind;
  confidence?: number;   // 0..1
}
export interface Turn { speaker: string; start: number; end: number; words: Word[] }
export interface Speaker { id: string; label?: string; role?: string }
export interface CueLine { words: WordRange; text: string }
export interface Cue { start: number; end: number; speaker: string; lines: CueLine[] }
export interface ProfileRules {
  maxCharsPerLine: number;
  maxLines: number;
  maxCps?: number;
  minDuration?: number;
  maxDuration?: number;
}
export interface TimeWindow { start: number; end: number }
export interface Profile {
  id: string;
  description?: string;
  /** The picture shape the cues are cut for, "W:H" (spec §9.1). */
  aspect: string;
  window?: TimeWindow;
  rules: ProfileRules;
  cues: Cue[];
}
export interface Edit { words: WordRange; from: string; to: string; reason: EditReason }
export interface StyleSettings {
  numbers?: 'digits' | 'words' | 'auto';
  currency?: 'symbol' | 'code' | 'words' | 'auto';
  guide?: string;
}
export interface Meta {
  title?: string;
  context?: string;
  style?: StyleSettings;
  models?: { text?: string; timing?: string; second?: string; llm?: string };
  generator?: string;
  createdAt?: string;
  [key: string]: unknown;
}
export interface OvertoneDocument {
  format: typeof FORMAT_NAME;
  version: typeof FORMAT_VERSION;
  language: string;
  duration: number;
  speakers: Speaker[];
  turns: Turn[];
  profiles: Profile[];
  edits?: Edit[];
  meta?: Meta;
}

/** A word with its global index and context, as produced by flattenWords(). */
export interface FlatWord extends Word { index: number; speaker: string; turn: number }
