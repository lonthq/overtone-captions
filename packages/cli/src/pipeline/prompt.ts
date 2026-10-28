// The transcription prompt of every chunk (transcribe stage, --two-pass) and the shorter one for empty-chunk retries.
import type { ResolvedConfig } from '../config.js';
import { GLOSSARY_PREFIX } from '../echo.js';

/** Characters of the previous chunk's text sent as continuity prompt. */
export const PROMPT_TAIL = 300;
/**
 * Longest transcription prompt, in characters. Providers give no reliable limit (Whisper's is about 224 tokens;
 * gpt-transcribe and Azure state none), so this stays conservative.
 */
export const MAX_PROMPT_CHARS = 2000;
/** Longest glossary list in the prompt, in characters (whole terms only). */
const MAX_GLOSSARY_CHARS = 1000;

/** "Names and terms: a, b, c." with as many whole terms as fit in `max` characters; '' when none fit. */
function glossaryLine(terms: readonly string[], max: number): string {
  const room = max - GLOSSARY_PREFIX.length - 1; // the closing "."
  let list = '';
  for (const term of terms) {
    const next = list ? `${list}, ${term}` : term;
    if (next.length > room) break;
    list = next;
  }
  return list ? `${GLOSSARY_PREFIX}${list}.` : '';
}

/**
 * Prompt for the text model: context, glossary, style rules and the previous chunk's tail. The only place the glossary
 * enters the transcription prompt. Never over MAX_PROMPT_CHARS: the context gives way first, then the glossary (whole
 * terms), then the style guide; the tail is kept.
 */
export function textPrompt(cfg: ResolvedConfig, previousText?: string): string | undefined {
  let context = cfg.context ?? '';
  let glossaryMax = MAX_GLOSSARY_CHARS;
  let guide = cfg.style.guide ?? '';
  const fixed: string[] = [];
  if (cfg.style.numbers === 'digits') fixed.push('Numbers are written as digits.');
  if (cfg.style.numbers === 'words') fixed.push('Numbers are written as words.');
  if (cfg.style.currency === 'symbol') fixed.push('Amounts use currency symbols, e.g. €12.');
  if (cfg.style.currency === 'code') fixed.push('Amounts use currency codes, e.g. EUR 12.');
  if (cfg.style.currency === 'words') fixed.push('Amounts are written in words, e.g. twelve euros.');
  const tail = previousText ? previousText.slice(-PROMPT_TAIL) : '';

  const build = (): string[] => [context, glossaryLine(cfg.glossary, glossaryMax), ...fixed, guide, tail].filter(Boolean);
  const length = (parts: string[]) => parts.join('\n').length;

  let excess = length(build()) - MAX_PROMPT_CHARS;
  if (excess > 0 && context) {
    // the newline that joins the context disappears with it
    context = context.length + 1 > excess ? context.slice(0, context.length - excess).trimEnd() : '';
    excess = length(build()) - MAX_PROMPT_CHARS;
  }
  if (excess > 0 && cfg.glossary.length > 0) {
    const current = glossaryLine(cfg.glossary, glossaryMax).length;
    glossaryMax = Math.max(0, current - excess);
    excess = length(build()) - MAX_PROMPT_CHARS;
  }
  if (excess > 0 && guide) {
    guide = guide.length + 1 > excess ? guide.slice(0, guide.length - excess).trimEnd() : '';
  }
  const parts = build();
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * The empty-chunk retry prompt (text-base.ts): the glossary line and the tail of the preceding text, without context
 * or style rules; undefined when there is neither.
 */
export function namesPrompt(cfg: Pick<ResolvedConfig, 'glossary'>, previousText?: string): string | undefined {
  const parts = [glossaryLine(cfg.glossary, MAX_GLOSSARY_CHARS), previousText?.trim() ? previousText.trim().slice(-PROMPT_TAIL) : ''].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : undefined;
}
