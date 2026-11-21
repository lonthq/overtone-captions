// Where to listen for the spoken language, and what the answers mean (spec 2026-11-20). Pure: no I/O.
import type { Silence } from '../media/chunks.js';

/** Length of one sample (s). */
export const SAMPLE_SECONDS = 30;
/** Up to this duration the whole file is one sample. */
export const SINGLE_SAMPLE_MAX_SECONDS = 45;
/** Up to this duration: two samples (start and end); longer: three. */
export const TWO_SAMPLES_MAX_SECONDS = 90;
/** A sample with fewer words has no speech (a lone "okay", a lyric fragment). */
export const MIN_SAMPLE_WORDS = 5;
/** Sample centers as shares of the duration, for files longer than TWO_SAMPLES_MAX_SECONDS. */
const CENTERS = [0.15, 0.5, 0.85] as const;
/** A sample shorter than this after moving apart from the previous one is left out. */
const MIN_SAMPLE_SECONDS = 5;

export interface Span { start: number; end: number }
/** Words heard per primary language code in one sample. */
export interface SampleHeard extends Span { words: Record<string, number> }
/** One sample as stored in `meta.languageDetection.samples`; `language` only when it had speech. */
export interface SampleVerdict extends Span { language?: string; words: number }
/** `meta.languageDetection`. `language` and `provider` are left out where they do not apply. */
export interface LanguageDetection {
  verdict: 'sure' | 'unsure' | 'none' | 'silent';
  language?: string;
  provider?: string;
  samples?: SampleVerdict[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The stretches between silences. */
function speech(duration: number, silences: readonly Silence[]): Span[] {
  const out: Span[] = [];
  let t = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > t) out.push({ start: t, end: s.start });
    t = Math.max(t, s.end);
  }
  if (t < duration) out.push({ start: t, end: duration });
  return out;
}

/** `c`, or the nearest point of speech at or after `from` when `c` lies in a silence; undefined without speech. */
function nearestSpeech(c: number, spans: readonly Span[], from: number): number | undefined {
  let best: number | undefined;
  let dist = Infinity;
  for (const s of spans) {
    const lo = Math.max(s.start, from);
    if (lo >= s.end) continue;
    const p = clamp(c, lo, s.end);
    if (Math.abs(p - c) < dist) {
      dist = Math.abs(p - c);
      best = p;
    }
  }
  return best;
}

/** Up to three samples of SAMPLE_SECONDS, in time order, inside the file and apart. */
export function pickSamples(duration: number, silences: readonly Silence[]): Span[] {
  if (duration <= SINGLE_SAMPLE_MAX_SECONDS) return [{ start: 0, end: duration }];
  const half = SAMPLE_SECONDS / 2;
  const centers = duration <= TWO_SAMPLES_MAX_SECONDS ? [half, duration - half] : CENTERS.map((f) => f * duration);
  const spans = speech(duration, silences);
  const out: Span[] = [];
  for (const c0 of centers) {
    const prevEnd = out.at(-1)?.end ?? 0;
    const c = nearestSpeech(c0, spans, prevEnd);
    if (c === undefined) continue;
    const start = Math.max(clamp(c - half, 0, duration - SAMPLE_SECONDS), prevEnd);
    const end = Math.min(duration, start + SAMPLE_SECONDS);
    if (end - start >= MIN_SAMPLE_SECONDS) out.push({ start: round1(start), end: Math.min(round1(end), duration) });
  }
  return out;
}

/** The verdict over the samples (in time order) that `provider` heard. */
export function decideLanguage(samples: readonly SampleHeard[], provider: string): LanguageDetection {
  const verdicts: SampleVerdict[] = samples.map((s) => {
    const entries = Object.entries(s.words);
    const words = entries.reduce((n, [, w]) => n + w, 0);
    // the language with the most words; on a tie the first listed
    const top = entries.reduce<[string, number] | undefined>((best, e) => (!best || e[1] > best[1] ? e : best), undefined);
    return { start: s.start, end: s.end, ...(top && words >= MIN_SAMPLE_WORDS ? { language: top[0] } : {}), words };
  });
  const heard = verdicts.filter((v) => v.language !== undefined);
  if (heard.length === 0) return { verdict: 'none', provider, samples: verdicts };
  const languages = new Set(heard.map((v) => v.language!));
  if (languages.size === 1 && (heard.length >= 2 || samples.length === 1)) {
    return { verdict: 'sure', language: heard[0]!.language!, provider, samples: verdicts };
  }
  const total = new Map<string, number>();
  for (const v of heard) total.set(v.language!, (total.get(v.language!) ?? 0) + v.words);
  const most = Math.max(...total.values());
  // a tie goes to the earliest sample's language
  const language = heard.find((v) => total.get(v.language!) === most)!.language!;
  return { verdict: 'unsure', language, provider, samples: verdicts };
}
