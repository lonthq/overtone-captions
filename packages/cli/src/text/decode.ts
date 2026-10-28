/** The encodings `decodeText` reads. */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** Drop a leading byte order mark (U+FEFF) from decoded text. */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Decode a text file. A byte order mark decides first (UTF-8, UTF-16 LE/BE; the mark is dropped); else UTF-8, and
 * Windows-1252 (older Western European subtitle files) when that is invalid. Undefined for binary content (a NUL).
 */
export function decodeText(raw: Uint8Array): { text: string; encoding: TextEncoding } | undefined {
  const [a, b, c] = raw;
  let encoding: TextEncoding | undefined;
  if (a === 0xef && b === 0xbb && c === 0xbf) encoding = 'utf-8';
  else if (a === 0xff && b === 0xfe) encoding = 'utf-16le';
  else if (a === 0xfe && b === 0xff) encoding = 'utf-16be';
  if (encoding) {
    const text = stripBom(new TextDecoder(encoding).decode(raw));
    return text.includes('\0') ? undefined : { text, encoding };
  }
  if (raw.includes(0)) return undefined;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(raw), encoding: 'windows-1252' };
  }
}
