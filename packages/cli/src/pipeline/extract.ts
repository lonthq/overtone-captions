// Stage 1: the media's audio, a WAV for the timing engines and compressed upload chunks for the text provider.
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { hashJson, stableStringify } from '../cache.js';
import { STAGES } from '../config.js';
import { COMPRESSED, DEFAULT_MAX_CHUNK_SECONDS, extractAudio, LOUDNORM_FILTER } from '../media/extract.js';
import { MAX_DURATION_SECONDS, tooLong } from './duration.js';
import type { Run } from './run.js';
import type { ExtractData } from './types.js';

/** File name → size in bytes; missing files are left out. */
async function fileSizes(paths: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const p of paths) {
    const s = await stat(p).catch(() => undefined);
    if (s?.isFile()) out[basename(p)] = s.size;
  }
  return out;
}

/** The extracted audio: from the stage cache when its files are intact, else extracted again. */
export async function extractStage(run: Run): Promise<ExtractData> {
  const { cache, cfg, deps, log } = run;
  const maxChunkSeconds = DEFAULT_MAX_CHUNK_SECONDS;
  const normalizeLoudness = cfg.normalizeLoudness;
  // loudnorm only when set, so a run without it keeps its key and cached audio
  const extractKey = hashJson({ generator: run.generator, chunkBytes: cfg.chunkBytes, maxChunkSeconds, args: COMPRESSED.args, ...(normalizeLoudness ? { loudnorm: LOUDNORM_FILTER } : {}) });
  // The audio files are overwritten in place: drop extract.json first so an interrupted extraction is never trusted,
  // and reuse an entry only when its files still have the recorded sizes.
  const sizesMatch = async (d: ExtractData) => stableStringify(await fileSizes([d.wav, ...d.chunks.map((c) => c.path)])) === stableStringify(d.sizes ?? {});
  const extracted = await cache.read<ExtractData>('extract', extractKey);
  let audio: ExtractData;
  if (extracted !== undefined && (await sizesMatch(extracted))) {
    log.info(`[1/${STAGES.length}] extract: cached`);
    audio = extracted;
  } else {
    audio = await run.stage<ExtractData>('extract', async () => {
      await cache.remove('extract');
      const res = await (deps.extractAudio ?? extractAudio)(run.media, cache.dir, { chunkBytes: cfg.chunkBytes, maxChunkSeconds, normalizeLoudness });
      const data = { ...res, sizes: await fileSizes([res.wav, ...res.chunks.map((c) => c.path)]) };
      await cache.write('extract', extractKey, data);
      return data;
    });
  }
  if (audio.duration > MAX_DURATION_SECONDS) throw tooLong(audio.duration);
  return audio;
}
