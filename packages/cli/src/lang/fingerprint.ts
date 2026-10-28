import { createHash } from 'node:crypto';
import { SHARED, getPack, neutral } from './index.js';

/** Plain JSON for hashing: functions become their source, sets sorted arrays, regular expressions their source. */
function toData(value: unknown): unknown {
  if (typeof value === 'function') return `fn:${value.toString()}`;
  if (value instanceof RegExp) return `re:${value.source}/${value.flags}`;
  if (value instanceof Set) return [...value].map(toData).sort();
  if (Array.isArray(value)) return value.map(toData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, toData((value as Record<string, unknown>)[k])]));
  }
  return value;
}

const CACHE = new Map<string, string>();

/**
 * Short hash of the language data the align and refine stages read: the pack, the neutral pack and the shared
 * lists. Recorded in `meta.languageData` (see layoutMeta) so a layout can be reproduced. Not a cache key: editing a
 * pack does not invalidate cached stages. A number-word parser counts by its own source, not its imports.
 */
export function languageDataHash(language: string | undefined): string {
  const pack = getPack(language);
  let hash = CACHE.get(pack.code);
  if (!hash) {
    const data = {
      pack: toData(pack),
      neutral: toData(neutral),
      shared: toData(SHARED),
    };
    hash = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
    CACHE.set(pack.code, hash);
  }
  return hash;
}

/** Forget the computed hashes (tests that edit a pack in memory). */
export function resetLanguageDataHash(): void {
  CACHE.clear();
}
