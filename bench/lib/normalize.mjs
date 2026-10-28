// Text normalizers for WER. RESULTS.md ("Metrics") gives the rules in prose.
//
// normalizeWords(words, lang, mode) → tokens [{ t, src }], src being the input word's index.
//   'plain'      lowercase, no punctuation, diacritics folded (the usual WER)
//   'formatted'  casing kept, and . , ? as separate tokens
// English follows a subset of Whisper's EnglishTextNormalizer (Radford et al. 2022); other languages get fillers,
// digit grouping, symbols and punctuation only.

const FILLERS = {
  en: new Set(['hmm', 'mm', 'mhm', 'mmm', 'uh', 'um']), // Whisper's list
  nl: new Set(['eh', 'ehm', 'uh', 'uhm', 'hm', 'hmm', 'mm', 'mmm']),
};

// Whisper EnglishTextNormalizer contraction rules (applied to the lowercased word).
const CONTRACTIONS = [
  [/^won't$/, 'will not'], [/^can't$/, 'can not'], [/^let's$/, 'let us'], [/^ain't$/, 'aint'], [/^y'all$/, 'you all'],
  [/^ma'am$/, 'madam'], [/^'cause$/, 'because'],
  [/n't$/, ' not'], [/'re$/, ' are'], [/'d$/, ' would'], [/'ll$/, ' will'], [/'ve$/, ' have'], [/'m$/, ' am'],
];

// A subset of Whisper's British->American spelling map.
const SPELLING = Object.fromEntries(Object.entries({
  colour: 'color', colours: 'colors', coloured: 'colored', colourful: 'colorful', favourite: 'favorite', favourites: 'favorites',
  favour: 'favor', behaviour: 'behavior', neighbour: 'neighbor', neighbours: 'neighbors', honour: 'honor', labour: 'labor',
  humour: 'humor', rumour: 'rumor', centre: 'center', centres: 'centers', metre: 'meter', metres: 'meters', theatre: 'theater',
  organise: 'organize', organised: 'organized', organisation: 'organization', organisations: 'organizations',
  realise: 'realize', realised: 'realized', recognise: 'recognize', recognised: 'recognized', apologise: 'apologize',
  prioritise: 'prioritize', summarise: 'summarize', customise: 'customize', customisable: 'customizable',
  personalise: 'personalize', personalised: 'personalized', minimise: 'minimize', maximise: 'maximize', standardise: 'standardize',
  analyse: 'analyze', analysed: 'analyzed', programme: 'program', programmes: 'programs', travelled: 'traveled', travelling: 'traveling',
  cancelled: 'canceled', modelling: 'modeling', labelled: 'labeled', grey: 'gray', licence: 'license', defence: 'defense',
  offence: 'offense', splendour: 'splendor', harbour: 'harbor', armour: 'armor', vapour: 'vapor', parlour: 'parlor', odour: 'odor', vigour: 'vigor', endeavour: 'endeavor', practise: 'practice', catalogue: 'catalog', dialogue: 'dialog', mum: 'mom', okay: 'ok', 'o.k.': 'ok',
}));

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { thousand: 1e3, million: 1e6, billion: 1e9 };
const isNumWord = (w) => w in UNITS || w in TENS || w === 'hundred' || w in SCALES;

const foldDiacritics = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '');

/** Text-level preparation before splitting into words. */
function prepText(text, lang) {
  let s = text.normalize('NFKC').replace(/[‘’ʼ`´]/g, "'").replace(/[“”„«»]/g, '"');
  s = s.replace(/\[[^\]]*\]|<[^>]*>/g, ' '); // markup such as [laughter] or <noise>
  if (lang === 'en') s = s.replace(/(\d),(?=\d{3}\b)/g, '$1'); // 1,000 -> 1000
  else { s = s.replace(/(\d)\.(?=\d{3}\b)/g, '$1'); s = s.replace(/(\d),(?=\d)/g, '$1.'); } // 10.000 -> 10000, 2,5 -> 2.5
  const words = { en: ['percent', 'dollars', 'euros', 'pounds'], nl: ['procent', 'dollar', 'euro', 'pond'] }[lang] ?? ['%', '$', '€', '£'];
  s = s.replace(/%/g, ` ${words[0]}`);
  s = s.replace(/\$\s?(\d[\d.]*)/g, `$1 ${words[1]}`).replace(/€\s?(\d[\d.]*)/g, `$1 ${words[2]}`).replace(/£\s?(\d[\d.]*)/g, `$1 ${words[3]}`);
  s = s.replace(/[–—…]/g, (m) => (m === '…' ? '.' : ' ')); // dashes split, ellipsis is a stop
  return s;
}

const PUNCT_MAP = { '.': '.', '!': '.', '?': '?', ',': ',', ';': ',', ':': ',' };

/** Split one raw token into word parts and trailing punctuation marks. */
function splitToken(raw) {
  // hyphens and slashes join words; split them into separate words
  const parts = raw.split(/[-/]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /^([^\p{L}\p{N}']*)(.*?)([^\p{L}\p{N}']*)$/u.exec(p);
    let core = m[2];
    const trail = m[3];
    // remaining inner symbols (except apostrophes and a decimal point between digits) become spaces
    core = core.replace(/(\d)\.(\d)/g, '$1\u0000$2').replace(/[^\p{L}\p{N}'\u0000]+/gu, ' ').replace(/\u0000/g, '.');
    core = core.replace(/^'+|'+$/g, '');
    const words = core.split(/\s+/).filter(Boolean);
    const marks = [];
    for (const ch of trail) if (PUNCT_MAP[ch] && marks.at(-1) !== PUNCT_MAP[ch]) marks.push(PUNCT_MAP[ch]);
    words.forEach((w, i) => out.push({ w, marks: i === words.length - 1 ? marks : [] }));
    if (!words.length && marks.length && out.length) out.at(-1).marks.push(...marks);
  }
  return out;
}

/** Spelled-out English numbers -> digits over items { w (lowercase), … }; returns a new list. */
function convertNumbers(items) {
  const out = [];
  for (let i = 0; i < items.length; ) {
    if (!isNumWord(items[i].lw)) { out.push(items[i]); i++; continue; }
    let total = 0, cur = 0, j = i, last = null;
    while (j < items.length) {
      const w = items[j].lw;
      if (w in UNITS) {
        if (last === 'unit' || last === 'teen' || (last === 'tens' && UNITS[w] >= 10)) break;
        cur += UNITS[w]; last = UNITS[w] >= 10 ? 'teen' : 'unit';
      } else if (w in TENS) {
        if (last === 'unit' || last === 'teen' || last === 'tens') break;
        cur += TENS[w]; last = 'tens';
      } else if (w === 'hundred') {
        if (last === 'hundred' || (cur % 100) === 0 && cur !== 0) break;
        cur = (cur || 1) * 100; last = 'hundred';
      } else if (w in SCALES) {
        if (last === null && cur === 0) break;
        total += (cur || 1) * SCALES[w]; cur = 0; last = 'scale';
      } else if (w === 'and' && (last === 'hundred' || last === 'scale') && j + 1 < items.length && (items[j + 1].lw in UNITS || items[j + 1].lw in TENS)) {
        last = 'and';
      } else break;
      const stop = items[j].marks.length > 0;
      j++;
      if (stop) break; // punctuation ends a number
    }
    if (j === i) { out.push(items[i]); i++; continue; }
    let value = String(total + cur);
    // decimals: "two point five" -> 2.5
    if (items[j]?.lw === 'point' && items[j - 1].marks.length === 0 && UNITS[items[j + 1]?.lw] < 10) {
      let k = j + 1, frac = '';
      while (k < items.length && UNITS[items[k].lw] < 10) { frac += UNITS[items[k].lw]; k++; if (items[k - 1].marks.length) break; }
      value += `.${frac}`; j = k;
    }
    const first = items[i], lastItem = items[j - 1];
    out.push({ ...first, w: value, lw: value, marks: lastItem.marks });
    i = j;
  }
  return out;
}

const keepCase = (orig, repl) => (/^\p{Lu}/u.test(orig) ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl);

export function normalizeWords(words, lang = 'en', mode = 'plain') {
  const L = lang.toLowerCase().slice(0, 2) === 'en' ? 'en' : lang.toLowerCase().slice(0, 2);
  const fillers = FILLERS[L] ?? new Set();
  // 1. split every source word into items { w, lw, marks, src }
  let items = [];
  words.forEach((word, src) => {
    for (const raw of prepText(word.text ?? '', L).split(/\s+/).filter(Boolean)) {
      for (const p of splitToken(raw)) items.push({ w: p.w, lw: p.w.toLowerCase(), marks: p.marks, src });
    }
  });
  // 2. fillers (dropped together with their punctuation)
  items = items.filter((it) => !fillers.has(it.lw.replace(/'/g, '')));
  // 3. English: contractions, spelling, numbers
  if (L === 'en') {
    const expanded = [];
    for (const it of items) {
      let r = it.lw;
      for (const [re, rep] of CONTRACTIONS) if (re.test(r)) { r = r.replace(re, rep); break; }
      const parts = r.split(' ');
      parts.forEach((p, k) => {
        const sp = SPELLING[p] ?? p;
        const w = k === 0 ? keepCase(it.w, sp) : sp;
        expanded.push({ w, lw: sp, marks: k === parts.length - 1 ? it.marks : [], src: it.src });
      });
    }
    items = convertNumbers(expanded);
  }
  // 4. drop apostrophes inside words ("it's" -> "its", "zo'n" -> "zon")
  const toks = [];
  for (const it of items) {
    const w = it.w.replace(/'/g, '');
    if (!w) continue;
    if (mode === 'plain') toks.push({ t: foldDiacritics(w.toLowerCase()), src: it.src });
    else {
      toks.push({ t: w, src: it.src });
      for (const m of it.marks) toks.push({ t: m, src: it.src, punct: true });
    }
  }
  return toks;
}

/** Words of a whitespace-separated string. */
export const wordsFromText = (text) => text.split(/\s+/).filter(Boolean).map((t) => ({ text: t }));
