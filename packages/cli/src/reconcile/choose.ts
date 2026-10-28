// The chooser: per disagreement region, an LLM keeps the caption or changes it, judging from the hearings and the
// context. A change no hearing wrote goes on the review list (vote.ts).
import { isRefusal, type JsonSchema, type LlmProvider } from '../providers/types.js';
import type { RefusalSink } from '../refusals.js';
import { runLimited } from '../refine/llm-steps.js';
import { phrase } from './phonetics.js';
import type { EngineWords, Region } from './regions.js';
// vote.ts imports this module too; VOTE is read only when a prompt is built, after both modules have loaded.
import { VOTE } from './vote.js';

/** A region as the chooser sees it, with what each engine and the snippet re-listen (if shown) heard. */
export interface ChooserItem {
  region: Region;
  /** The text before and after the region. */
  before: string;
  after: string;
  /** What the snippet re-listen heard in the region's place ('' for nothing); shown for class c. */
  relisten?: { span: string; whole: string };
}

export interface ChooserAnswer { id: number; decision: 'keep' | 'change'; text: string; basis: string }

const CHOOSER_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['spans'],
  properties: {
    spans: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'decision', 'text', 'basis'],
        properties: {
          id: { type: 'string' },
          decision: { type: 'string', enum: ['keep', 'change'] },
          text: { type: 'string', description: 'the words for the stretch (the current caption for keep)' },
          basis: { type: 'string', description: 'which hearings support it, in a few words' },
        },
      },
    },
  },
};

/** Regions per request, and requests in flight at once. */
export const CHOOSER = { batch: 8, concurrency: 4 } as const;

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', nl: 'Dutch', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese' };

/** How the prompt names the text engine when the caller names none. */
const DEFAULT_TEXT_ENGINE = 'gpt-transcribe';

/** The chooser's instructions; `engine` names the text engine, whose words the caption is. */
const chooserSystem = (engine: string) => `You repair captions for deaf and hard-of-hearing viewers. Each stretch below is a place where independent speech recognizers heard the same audio differently. The CURRENT CAPTION comes from the strongest engine (${engine}): it is usually right, also on wording and names, but it sometimes mishears a phrase as a fluent wrong one, or skips a short line shouted over music. The other engines heard the whole file on their own (plus short snippets sent again where they had heard nothing).
Judge each stretch as a whole, with the hearings, their sound spellings, the lines around it, the topic and the names. A fluent but wrong line is worse than an obviously garbled one, because the viewer cannot check it by ear: base a change on what was audible. Usually the right line is one of the hearings, or a mix of them. When the hearings are all wrong in a way the context makes clear (a name from the topic or the names list misheard, a number, a homophone that does not fit), you may write the words that were said; they should sound like what the engines heard. Such a line is applied and listed for a person to check by ear.
The re-listen of a snippet often returns nothing for short or noisy audio: an empty re-listen is no evidence against a line.
For each stretch decide:
- "keep": the current caption is right, or no other hearing is clearly better. When unsure, keep.
- "change": give the words for exactly the bracketed stretch of the CURRENT CAPTION (not the words around it, which stay as they are), with normal casing and punctuation. Where the caption has no words, "change" means inserting the words you give at that point.
Insert only real speech that matters to a viewer (a line, an exclamation, a reply, a name). Do not add fillers, stutters, repeated words or false starts: the captions leave those out on purpose. Keep the caption's style (spelling of names, how numbers are written, "want to" rather than "wanna"). A number, a negation or a name may change when a hearing or the context makes clear what was said. Never remove a stretch the caption has: give a line or keep.
Answer in JSON.`;

const AGREEMENT: Partial<Record<Region['cls'], string>> = {
  a: 'The two engines agree with each other here; the caption has no words.',
  b: 'The two engines agree with each other here and differ from the caption.',
};

function sounds(text: string, language: string): string {
  if (!text.trim()) return '';
  const p = phrase(text, language);
  return ` [sounds: ${p.phones.join(' ') || '-'}; ${p.syllables} syllables]`;
}

/** The prompt block of one region. */
function chooserBlock(item: ChooserItem, engines: readonly EngineWords[], language: string, textEngine: string, textIsEngine?: number): string {
  const r = item.region;
  const lines = [`### ${r.id}  (${r.start.toFixed(1)}–${r.end.toFixed(1)} s)`, `Before: …${item.before.slice(-220)}`];
  const show = (label: string, around: { before: string; after: string } | undefined, text: string) =>
    `- ${label}: …${around?.before ?? ''} [${text}] ${around?.after ?? ''}… → stretch: "${text}"${sounds(text, language)}`;
  lines.push(show(`CURRENT CAPTION (${textEngine}, whole file)`, r.around.text, r.text) + (r.text.trim() ? '' : '  (the caption has no words here)'));
  engines.forEach((e, k) => {
    if (k === textIsEngine) return;
    lines.push(show(`${e.label} (whole file)`, r.around[e.id], r.heard[k]!.map((w) => w.text).join(' ')));
  });
  if (item.relisten) lines.push(`- ${textEngine} re-listen of this snippet alone (±${VOTE.pad} s): stretch "${item.relisten.span}"${sounds(item.relisten.span, language)}; whole snippet: "${item.relisten.whole}"`);
  const note = AGREEMENT[r.cls];
  if (note) lines.push(`Note: ${note}`);
  lines.push(`After: ${item.after.slice(0, 220)}…`);
  return lines.join('\n');
}

export interface ChooseOptions {
  language: string;
  context?: string;
  names: readonly string[];
  /** How the prompt names the text engine ("gpt-transcribe", "whisper-1"). Default gpt-transcribe. */
  textEngine?: string;
  /** The engine whose words are the caption (the text engine gave none); left out of the hearings shown. */
  textIsEngine?: number;
  /** Told about a refused request; its regions keep the caption. */
  onRefusal?: RefusalSink;
}

/**
 * Ask the chooser about every item, CHOOSER.batch regions per request. A missing answer means "keep"; a refused request
 * keeps the caption for its regions and is reported to `onRefusal`.
 */
export async function choose(llm: LlmProvider, items: readonly ChooserItem[], engines: readonly EngineWords[], o: ChooseOptions): Promise<Map<number, ChooserAnswer>> {
  const groups: ChooserItem[][] = [];
  for (let k = 0; k < items.length; k += CHOOSER.batch) groups.push(items.slice(k, k + CHOOSER.batch));
  const language = o.language.split(/[-_]/)[0]!.toLowerCase();
  const textEngine = o.textEngine ?? DEFAULT_TEXT_ENGINE;
  const system = chooserSystem(textEngine);
  const fallback = o.textIsEngine !== undefined
    ? `\nNote: for this file ${textEngine} returned no text, so the CURRENT CAPTION is ${engines[o.textIsEngine]?.label ?? 'another engine'}'s own text.`
    : '';
  const answers = await runLimited(groups.map((group) => async () => {
    const user = [
      `Language: ${LANGUAGE_NAMES[language] ?? o.language}.${o.context ? ` Topic: ${o.context}` : ''}`,
      o.names.length > 0 ? `Names: ${o.names.join(', ')}` : '',
      fallback,
      ...group.map((item) => chooserBlock(item, engines, language, textEngine, o.textIsEngine)),
      `Return one entry per stretch: ${group.map((g) => g.region.id).join(', ')}.`,
    ].filter(Boolean).join('\n\n');
    try {
      const res = await llm.complete<{ spans: Array<{ id: string; decision: 'keep' | 'change'; text: string; basis: string }> }>({
        name: 'choose', system, user, schema: CHOOSER_SCHEMA, schemaName: 'repairs', effort: 'low',
      });
      return res.spans;
    } catch (err) {
      if (!isRefusal(err)) throw err;
      const n = group.length;
      o.onRefusal?.({
        provider: err.provider, by: err.by, request: `the text vote's chooser request (${n} region${n === 1 ? '' : 's'})`,
        start: Math.min(...group.map((g) => g.region.start)), end: Math.max(...group.map((g) => g.region.end)),
        instead: 'kept the text base there',
      });
      return [];
    }
  }), CHOOSER.concurrency);
  const out = new Map<number, ChooserAnswer>();
  const ids = new Set(items.map((i) => i.region.id));
  for (const spans of answers) {
    for (const s of spans ?? []) {
      const id = Number(String(s.id).replace(/^#/, ''));
      if (ids.has(id)) out.set(id, { id, decision: s.decision, text: s.text, basis: s.basis });
    }
  }
  return out;
}
