import type { Logger } from '../log.js';
import { isRefusal, type Effort, type JsonSchema, type LlmProvider } from '../providers/types.js';
import type { RefusalSink } from '../refusals.js';

/** The inferred context for the editor, plus names and terms as hints (not a glossary). */
export interface InferredContext { topic: string; names: string[]; terms: string[] }

/** Words of the transcript sent in full; longer transcripts add a few samples of the rest. */
export const CONTEXT_HEAD_WORDS = 4000;
export const CONTEXT_SAMPLES = 4;
export const CONTEXT_SAMPLE_WORDS = 250;
/** Most names and terms kept (each at most MAX_TERM_CHARS characters). */
export const MAX_INFERRED = 30;
const MAX_TERM_CHARS = 60;
const MAX_TOPIC_CHARS = 600;
/** One short call: little reasoning needed. */
export const CONTEXT_EFFORT: Effort = 'low';

export const CONTEXT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'names', 'terms'],
  properties: {
    topic: { type: 'string' },
    names: { type: 'array', items: { type: 'string' } },
    terms: { type: 'array', items: { type: 'string' } },
  },
};

/** The transcript as sent: the first CONTEXT_HEAD_WORDS words, then CONTEXT_SAMPLES evenly spaced samples of the rest, each after a "[…]" line. */
export function contextExcerpt(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= CONTEXT_HEAD_WORDS + CONTEXT_SAMPLES * CONTEXT_SAMPLE_WORDS) return words.join(' ');
  const parts = [words.slice(0, CONTEXT_HEAD_WORDS).join(' ')];
  const rest = words.length - CONTEXT_HEAD_WORDS;
  const step = rest / CONTEXT_SAMPLES;
  for (let k = 0; k < CONTEXT_SAMPLES; k++) {
    const from = CONTEXT_HEAD_WORDS + Math.floor(k * step + (step - CONTEXT_SAMPLE_WORDS) / 2);
    parts.push(words.slice(from, from + CONTEXT_SAMPLE_WORDS).join(' '));
  }
  return parts.join('\n[…]\n');
}

export function contextPrompt(text: string, language?: string): { system: string; user: string } {
  const system = [
    'You read a machine transcript of an audio or video recording and describe it for a caption editor who will correct the transcript.',
    'topic: 1–2 sentences: what the recording is about, its setting (for example an interview, a lecture, a meeting, a podcast, an advertisement) and its tone. Write it in the language of the transcript. Describe only what the transcript shows; never invent details such as dates or places.',
    'names: names of people, organizations, products, programs and places that occur in the transcript, spelled correctly when you are sure of the usual spelling, otherwise as in the transcript.',
    'terms: specialist terms and jargon that occur in the transcript.',
    `List each name or term once, at most ${MAX_INFERRED} of each, most important first. Only list what occurs in the transcript; return empty lists when there is nothing to list.`,
  ].join('\n');
  const user = `${language ? `Language: ${language}\n` : ''}Transcript:\n${contextExcerpt(text)}`;
  return { system, user };
}

/** Trimmed, case-insensitively de-duplicated strings of a sensible length; anything else is dropped. */
function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const t = v.trim().replace(/\s+/g, ' ');
    if (!t || t.length > MAX_TERM_CHARS || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX_INFERRED) break;
  }
  return out;
}

/**
 * One short LLM call on the transcript when no --context is given. Undefined, with a warning, when the call fails or
 * the answer has no topic: the run goes on without a context.
 */
export async function inferContext(llm: LlmProvider, text: string, opts: { language?: string; log: Logger; refused?: { onRefusal: RefusalSink; duration: number } }): Promise<InferredContext | undefined> {
  try {
    const res = await llm.complete<Partial<InferredContext>>({ name: 'context', ...contextPrompt(text, opts.language), schema: CONTEXT_SCHEMA, effort: CONTEXT_EFFORT });
    const topic = typeof res?.topic === 'string' ? res.topic.trim().replace(/\s+/g, ' ').slice(0, MAX_TOPIC_CHARS) : '';
    if (!topic) {
      opts.log.warn('context inference returned no topic; continuing without a context');
      return undefined;
    }
    return { topic, names: cleanList(res.names), terms: cleanList(res.terms) };
  } catch (err) {
    if (isRefusal(err) && opts.refused) {
      opts.refused.onRefusal({ provider: err.provider, by: err.by, request: 'the context inference request', start: 0, end: opts.refused.duration, instead: 'went on without an inferred context' });
      return undefined;
    }
    opts.log.warn(`context inference failed (${(err as Error).message}); continuing without a context`);
    return undefined;
  }
}
