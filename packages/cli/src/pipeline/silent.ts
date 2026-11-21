// Silent media (no audio track, or a peak below SILENT_MAX_VOLUME_DB): an empty document, no provider call.
import { basename } from 'node:path';
import { assertValid, FORMAT_NAME, FORMAT_VERSION, roundTime, type OvertoneDocument } from 'overtone-format';
import { SILENT_MAX_VOLUME_DB } from '../media/extract.js';
import type { Loudness } from '../media/loudness.js';
import { formatSummary } from '../summary.js';
import { formatUsage, type UsageMeter } from '../usage.js';
import { writeDocument } from './export.js';
import type { Plan } from './preflight.js';
import type { Run } from './run.js';
import type { ExtractData, PipelineResult } from './types.js';

export async function silentRun(run: Run, plan: Pick<Plan, 'wantsMp4' | 'profiles' | 'textFile'>, audio: ExtractData, meter: UsageMeter, loudness?: Loudness): Promise<PipelineResult> {
  const { cfg, deps, log } = run;
  log.info(audio.noAudio
    ? '  no audio track: nothing to transcribe'
    : `  the audio is silent (peak ${audio.maxVolume} dB, below ${SILENT_MAX_VOLUME_DB} dB): nothing to transcribe`);
  if (plan.textFile) log.warn(`--text-file: the text of ${basename(plan.textFile.path)} was not used, because the media is silent`);
  const doc: OvertoneDocument = assertValid({
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    language: 'und',
    duration: roundTime(audio.duration),
    speakers: [],
    turns: [],
    profiles: plan.profiles.map((p) => ({ ...p, cues: [] })),
    edits: [],
    meta: {
      languageDetection: { verdict: 'silent' },
      ...(loudness ? { loudness } : {}),
      style: cfg.style,
      generator: run.generator,
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    },
  } satisfies OvertoneDocument);
  if (plan.wantsMp4) log.info('  no captions to burn');
  const written = await writeDocument(run, plan, doc);
  const summary = formatSummary({ words: [], edits: 0, rejected: 0, review: 0, speakers: 0, profiles: doc.profiles });
  const usage = meter.list();
  return { doc, written, summary, rejected: 0, review: [], usage, usageLine: formatUsage(usage), refusals: [] };
}
