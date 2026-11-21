// The loudness measurement runs next to the paid calls (it is local and takes ~20 s per hour of audio) and is awaited
// when the document is built. It never fails the run.
import { measureLoudness, type Loudness } from '../media/loudness.js';
import type { Run } from './run.js';
import type { ExtractData } from './types.js';

/** Starts the measurement; resolves to undefined for a file without audio or when it fails (one debug line). */
export function startLoudness(run: Run, audio: ExtractData, signal: AbortSignal): Promise<Loudness | undefined> {
  if (audio.noAudio) return Promise.resolve(undefined);
  return (run.deps.measureLoudness ?? measureLoudness)(run.media, signal).catch((err: unknown) => {
    run.log.debug(`loudness not measured: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
}
