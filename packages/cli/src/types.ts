import type { MatchKind } from 'overtone-format';

/** A word from the timing provider. Times in seconds; speaker ids are "S1", "S2", … */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
  speaker?: string;
  confidence?: number;
}

/**
 * What the timing side heard at a text word: the display text of timing words `first..last`. Indices point into the
 * timing words sorted by start, or from `RelistenOptions.heardBase` on for snippet words, so ranges never collide.
 * Words sharing timing words (a split, or one timed word for two text words) carry the same range.
 */
export interface Heard { text: string; first: number; last: number }

/** A text-provider word after alignment: text from the text side, time and speaker from the timing side. */
export interface AlignedWord {
  text: string;
  start: number;
  end: number;
  speaker: string;
  match: MatchKind;
  confidence: number;
  /** What the timing side heard there; absent when it heard nothing. */
  heard?: Heard;
}
