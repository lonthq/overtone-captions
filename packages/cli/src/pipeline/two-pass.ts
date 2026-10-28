// --two-pass: transcribe again with the inferred context and names in the prompt (part of the timing stage).
import { UserError } from '../errors.js';
import { wordsInSpan } from '../hearings.js';
import { normalizeLoudness } from '../media/extract.js';
import { span } from './duration.js';
import type { Plan } from './preflight.js';
import { textPrompt } from './prompt.js';
import { isInternalError, type Run } from './run.js';
import { echoGuard, wordsOver } from './text-base.js';
import type { Hearings } from './timing.js';
import type { TextCalls } from './transcribe.js';
import type { CoverageData, TranscribeChunk, TranscribeData } from './types.js';
import type { MediaContext } from './editor.js';

export interface TwoPassInput {
  plan: Pick<Plan, 'sel'>;
  calls: TextCalls;
  covered: CoverageData;
  hearings: Hearings;
  context: MediaContext;
}

/** The text for the align stage: the text base, or its second pass with --two-pass and an inferred context. */
export async function twoPassStep(run: Run, { plan, calls, covered, hearings, context: { inferred, inferredTerms } }: TwoPassInput): Promise<TranscribeData> {
  const { cfg, deps, log } = run;
  if (!cfg.twoPass || !inferred) return { chunks: covered.chunks };
  const unecho = echoGuard(hearings.language);
  const passCfg = { ...cfg, context: inferred.topic, glossary: [...cfg.glossary, ...inferredTerms.filter((t) => !cfg.glossary.includes(t))] };
  return run.step<TranscribeData>('timing', 'two-pass', async () => {
    const chunks: TranscribeChunk[] = [];
    for (const [k, c] of covered.chunks.entries()) {
      // an engine's words stay; a chunk heard only after loudness normalization is sent normalized again
      if (c.source) { chunks.push(c); continue; }
      const chunk = `chunk ${c.index + 1}/${calls.pieces.length}`;
      // nothing heard there by the text provider or an independent engine (music, silence): a second answer would be
      // made up. Only an independent engine counts (not --timing same, not a failed timing).
      const listened = !plan.sel.timing.same && hearings.engines.some((e) => e.words.length > 0);
      if (!c.text.trim() && listened && hearings.engines.every((e) => wordsInSpan(e.words, c.start, c.end, c.index === calls.pieces.length - 1).length === 0)) {
        chunks.push(c);
        log.info(`  ${chunk} (second pass): skipped; the first pass and every engine heard no words there`);
        continue;
      }
      const piece = calls.pieces[k]!;
      const prompt = textPrompt(passCfg, chunks[chunks.length - 1]?.text);
      let res: TranscribeChunk;
      try {
        const path = c.loudnorm ? await (deps.normalizeLoudness ?? normalizeLoudness)(piece.path) : piece.path;
        res = await calls.transcribe('timing', piece, prompt, path, c.languageHint);
      } catch (err) {
        // an error to fix, or a bug in Overtone: run.step reports it (a refusal is handled in calls.transcribe)
        if (err instanceof UserError || isInternalError(err)) throw err;
        // the first pass is complete, so a failed second pass of one chunk keeps it
        log.warn(`--two-pass: ${chunk} (${span(c)}) failed (${(err as Error).message}); keeping the first pass there. The failed request is not cached: run the command again to retry.`);
        chunks.push(c);
        continue;
      }
      // never worse than the first pass: an empty or echoed second answer keeps the first
      const echoed = !plan.sel.timing.same && unecho(res.text, prompt, wordsOver(hearings.timing.words, c)).echoes.length > 0;
      const keep = echoed || !res.text.trim();
      chunks.push(keep ? c : { ...res, ...(c.loudnorm ? { loudnorm: true as const } : {}), ...(c.languageHint ? { languageHint: c.languageHint } : {}) });
      log.info(`  ${chunk} (second pass): ${res.text.length} chars${echoed ? '; it echoes its prompt, the first pass is kept' : keep ? '; empty, the first pass is kept' : ''}`);
    }
    return { chunks };
  });
}
