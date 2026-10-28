import { SHARED, rulesOf, type Lang, type ParsedNumber } from '../lang/index.js';

export type { ParsedNumber } from '../lang/index.js';

/** Canonical comparison key for a number: "12", "1.5", "1000000", ordinals "3th". */
export function numberKey(value: number, ordinal: boolean): string {
  const s = String(Number(value.toFixed(6)));
  return ordinal ? `${s}th` : s;
}

/**
 * Digits: "12", "1,000", "1.5", "12,50" (nl), "1st", "3e", "8ste". The ordinal suffixes and the decimal and
 * thousands separators come from the language pack.
 */
export function parseDigits(piece: string, lang: Lang): { value: number; ordinal: boolean; raw?: string } | null {
  const rules = rulesOf(lang);
  const ord = rules.ordinalDigits.exec(piece);
  if (ord) return { value: Number(ord[1]), ordinal: true };
  if (!/^\d[\d.,]*$/.test(piece) || /[.,]$/.test(piece)) return null;
  // "007", "020", the "06" of a phone number: not quantities, so they keep their digits
  if (/^0\d+$/.test(piece)) return { value: Number(piece), ordinal: false, raw: piece };
  const decimal = rules.decimalSeparator;
  const thousands = decimal === ',' ? '.' : ',';
  let s = piece;
  if (decimal === undefined) {
    // a separator followed by exactly three digits (repeated) is a thousands separator, otherwise decimal
    s = /^\d{1,3}([.,]\d{3})+$/.test(s) ? s.replace(/[.,]/g, '') : s.replace(',', '.');
  } else {
    const groups = new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})+(\\${decimal}\\d+)?$`);
    if (groups.test(s)) s = s.split(thousands).join('');
    else if (s.includes(thousands)) {
      // the other language's decimal style: one or two digits after a single separator ("12.50" in nl, "12,50" in en)
      if (!new RegExp(`^\\d+\\${thousands}\\d{1,2}$`).test(s)) return null;
      s = s.replace(thousands, '.');
    }
    s = s.replace(decimal, '.');
  }
  const value = Number(s);
  return Number.isFinite(value) ? { value, ordinal: false } : null;
}

/**
 * Parse a number at pieces[start]: digits (optionally with a scale word of any language, "1.5 million") or the
 * language's number words (`numbers.parseWords`). Null when no number starts there.
 */
export function parseNumberAt(pieces: readonly string[], start: number, lang: Lang): ParsedNumber | null {
  const d = parseDigits(pieces[start], lang);
  if (d) {
    const next = pieces[start + 1];
    if (!d.ordinal && next !== undefined && next in SHARED.scaleWords) return { value: d.value * SHARED.scaleWords[next], ordinal: false, length: 2 };
    return { ...d, length: 1 };
  }
  return rulesOf(lang).parseWords?.(pieces, start) ?? null;
}
