import { dict } from '../dict.js';
import type { ParsedNumber } from '../types.js';

// English number words for the `numbers.parseWords` field of the English pack.

const EN_UNITS: Readonly<Record<string, number>> = dict({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 });
const EN_TEENS: Readonly<Record<string, number>> = dict({
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
});
const EN_TENS: Readonly<Record<string, number>> = dict({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const EN_SCALES: Readonly<Record<string, number>> = dict({ thousand: 1e3, million: 1e6, billion: 1e9 });
const EN_ORD_UNITS: Readonly<Record<string, number>> = dict({ first: 1, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 });
const EN_ORD_TEENS: Readonly<Record<string, number>> = dict({
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19,
});
const EN_ORD_TENS: Readonly<Record<string, number>> = dict({
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
});

type Cat = 'start' | 'a' | 'unit' | 'teen' | 'tens' | 'hundred' | 'scale' | 'and';

/** English number words: "twenty one", "a hundred and five", "two million", "twenty-first" (pieces). */
export function parseEnglishWords(pieces: readonly string[], start: number): ParsedNumber | null {
  let total = 0;
  let current = 0;
  let last: Cat = 'start';
  let i = start;
  let consumedEnd = start; // exclusive index of the last accepted piece that may end a number
  let ordinal = false;
  let compound = false;
  for (; i < pieces.length; i++) {
    const p = pieces[i];
    // "second" is ordinal 2 only right after a tens word ("twenty-second"): alone it is the time unit ("wait a second")
    const compoundSecond = p === 'second' && last === 'tens';
    const unit = EN_UNITS[p] ?? EN_ORD_UNITS[p] ?? (compoundSecond ? 2 : undefined);
    const teen = EN_TEENS[p] ?? EN_ORD_TEENS[p];
    const tens = EN_TENS[p] ?? EN_ORD_TENS[p];
    const isOrd = compoundSecond || p in EN_ORD_UNITS || p in EN_ORD_TEENS || p in EN_ORD_TENS || p === 'hundredth' || p === 'thousandth' || p === 'millionth';
    if (p === 'a' && last === 'start') { current = 1; last = 'a'; continue; }
    if (unit !== undefined && ['start', 'tens', 'hundred', 'scale', 'and'].includes(last)) {
      current += unit; last = 'unit';
    } else if (teen !== undefined && ['start', 'hundred', 'scale', 'and'].includes(last)) {
      current += teen; last = 'teen';
    } else if (tens !== undefined && ['start', 'hundred', 'scale', 'and'].includes(last)) {
      current += tens; last = 'tens';
    } else if ((p === 'hundred' || p === 'hundredth') && ['a', 'unit', 'teen', 'tens'].includes(last) && current > 0 && current < 100) {
      current *= 100; last = 'hundred';
    } else if ((p in EN_SCALES || p === 'thousandth' || p === 'millionth') && ['a', 'unit', 'teen', 'tens', 'hundred'].includes(last)) {
      const scale = EN_SCALES[p] ?? (p === 'thousandth' ? 1e3 : 1e6);
      total += current * scale; current = 0; last = 'scale';
    } else if (p === 'and' && (last === 'hundred' || last === 'scale')) {
      last = 'and'; continue;
    } else {
      break;
    }
    consumedEnd = i + 1;
    if (isOrd) { ordinal = true; compound = compoundSecond; break; }
  }
  if (consumedEnd === start || last === 'a') return null;
  const parsed: ParsedNumber = { value: total + current, ordinal, length: consumedEnd - start };
  // "twenty-second" is also 20 and the time unit ("a twenty-second clip")
  if (compound) parsed.alternative = { value: total + current - 2, ordinal: false, length: consumedEnd - start - 1 };
  return parsed;
}
