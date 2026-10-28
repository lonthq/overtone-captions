import { detectLanguage, normalizeLanguageCode } from '../text/detect.js';

/** "nl-BE" → "nl" */
export const primary = (lang?: string) => lang?.split(/[-_]/)[0];

/**
 * The language for the timing stage and the document: the forced one, else the text provider's most frequent, else a
 * stopword guess on the text; undefined when unsure.
 */
export function chooseLanguage(
  forced: string | undefined,
  chunks: ReadonlyArray<{ text: string; language?: string }>,
): { language: string; source: string } | undefined {
  if (forced) return { language: forced, source: '--language' };
  const counts = new Map<string, number>();
  for (const c of chunks) {
    const code = normalizeLanguageCode(c.language);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const reported = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (reported) return { language: reported, source: 'from the text provider' };
  const guessed = detectLanguage(chunks.map((c) => c.text).join(' '));
  return guessed ? { language: guessed, source: 'detected from the text' } : undefined;
}
