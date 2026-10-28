// What every stage of a run shares: the configuration, the caches, and the stage wrapper (progress lines, errors).
import { hashFile, RequestCache, StageCache } from '../cache.js';
import { STAGES, type Stage } from '../config.js';
import { InternalError, UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { explainNetworkError } from '../providers/kit.js';
import { isRefusal } from '../providers/types.js';
import { refusalLine, type Refusal } from '../refusals.js';
import type { UsageMeter } from '../usage.js';
import { httpStatus, isRetryable, isTimeout, networkFailure } from '../util/retry.js';
import { GENERATOR } from '../version.js';
import type { PipelineConfig, PipelineDeps } from './types.js';

export interface Run {
  media: string;
  cfg: PipelineConfig;
  deps: PipelineDeps;
  log: Logger;
  env: NodeJS.ProcessEnv;
  /** `meta.generator` and part of the extract stage's key. */
  generator: string;
  /** The media's cache folder; only the extract stage keeps an entry there. */
  cache: StageCache;
  /** Every provider request, cached by what is sent (cache.ts). */
  requests: RequestCache;
  /** A numbered stage with "[n/6] name …" and "done in …" lines; its errors name the stage and how to resume. */
  stage<T>(name: Stage, run: () => Promise<T>): Promise<T>;
  /** A step inside a stage (no "[n/6]" lines); its errors name the stage and the step. */
  step<T>(parent: Stage, name: string, run: () => Promise<T>): Promise<T>;
  /** Refused requests the run went on without (refusals.ts), in order. */
  refusals: Refusal[];
  /** Records a refused request with a warning; all of them are reported again at the end. */
  refused(r: Refusal): void;
}

/**
 * A bug in Overtone, not a failed request: an InternalError, or a TypeError, RangeError or ReferenceError that is
 * neither a failed connection (Node's fetch throws TypeError "fetch failed") nor retryable.
 */
export function isInternalError(err: unknown): boolean {
  if (err instanceof InternalError) return true;
  if (!(err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError)) return false;
  return !networkFailure(err) && !isRetryable(err);
}

export async function openRun(media: string, cfg: PipelineConfig, deps: PipelineDeps, env: NodeJS.ProcessEnv, meter: UsageMeter): Promise<Run> {
  const { log } = deps;
  const cache = new StageCache(cfg.cacheDir, await hashFile(media), { useCache: cfg.useCache, fromStage: cfg.fromStage });
  let unwritable = false;
  const requests = new RequestCache(cache.dir, {
    useCache: cfg.useCache, fromStage: cfg.fromStage, onHit: (role, id) => meter.cached({ id, role }),
    onWriteError: (file, err) => {
      if (unwritable) return; // warn once: on a full disk every answer fails the same way
      unwritable = true;
      log.warn(`Could not cache a provider answer in ${file} (${err instanceof Error ? err.message : String(err)}); going on without the cache, so a re-run sends such requests again.`);
    },
  });
  /** How to continue after a failed stage; after a failed cache write, never claims every answer was cached. */
  const resume = (): string => {
    if (unwritable) {
      return cfg.useCache
        ? `Some provider answers could not be cached in ${cache.dir} (see the warning above); running the same command again reuses those that were and sends the others again.`
        : `With --no-cache the cached answers were ignored; some provider answers could not be cached in ${cache.dir} (see the warning above), so running the command again without --no-cache reuses those that were and sends the others again.`;
    }
    return cfg.useCache
      ? `Finished provider requests are cached in ${cache.dir}; run the same command again to continue.`
      : `With --no-cache the cached answers were ignored, but the finished provider requests were still cached in ${cache.dir}; run the command again without --no-cache to continue from them.`;
  };
  /**
   * A stage's error as the user should see it: a refused key or endpoint says what to check; a 4xx is not fixed by
   * running again, a transient failure is; a bug keeps its stack trace.
   */
  const fail = (what: string, err: unknown): never => {
    if (err instanceof UserError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (isRefusal(err)) {
      throw new UserError(`${what} failed: ${err.provider} refused the request (${err.by === 'model' ? 'the model declined' : 'content filter'}): ${message}\nThe same request is refused again, so running the command again does not help. If an agent runs Overtone for you, it should pass this message on to you.`);
    }
    const status = httpStatus(err);
    if (status === 401 || status === 403) {
      throw new UserError(`${what} failed: the provider refused the request (HTTP ${status}): ${message}\nCheck its API key and endpoint; "overtone providers" lists the environment variables.`);
    }
    if (status !== undefined && status < 500 && !isRetryable(err)) throw new UserError(`${what} failed: ${message}`);
    // a failed connection is the network or the address, not a bug
    if (networkFailure(err) && !isTimeout(err)) {
      const explained = (explainNetworkError(err) as Error | undefined)?.message ?? message;
      const check = 'Check the provider\'s endpoint or region variable and the network; "overtone providers" lists the variables.';
      // the resume hint only when a retry may help (an outage), not for a refused address
      throw new UserError(`${what} failed: ${explained}\n${check}${isRetryable(err) ? `\n${resume()}` : ''}`);
    }
    if (isInternalError(err)) {
      log.error(`${what} failed with an internal error; please report it with the stack trace below.`);
      throw err;
    }
    throw new UserError(`${what} failed: ${message}\n${resume()}`);
  };
  /** " (2 of 5 provider requests from the cache)" for the requests since `before`; '' when none came from it. */
  const fromCache = (before: { sent: number; cached: number }) => {
    const cached = requests.counts.cached - before.cached;
    const sent = requests.counts.sent - before.sent;
    if (cached === 0) return '';
    if (sent > 0) return ` (${cached} of ${cached + sent} provider requests from the cache)`;
    return cached === 1 ? ' (its provider request from the cache)' : ` (all ${cached} provider requests from the cache)`;
  };
  const step = async <T>(parent: Stage, name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      return fail(`Stage "${parent}" (${name})`, err);
    }
  };
  const stage = async <T>(name: Stage, run: () => Promise<T>): Promise<T> => {
    const n = `[${STAGES.indexOf(name) + 1}/${STAGES.length}] ${name}`;
    log.info(`${n} …`);
    const t0 = Date.now();
    const before = { ...requests.counts };
    let data: T;
    try {
      data = await run();
    } catch (err) {
      return fail(`Stage "${name}"`, err);
    }
    log.info(`${n}: done in ${((Date.now() - t0) / 1000).toFixed(1)} s${fromCache(before)}`);
    return data;
  };
  // The extract stage's key holds the generator, so a new version extracts again; identical audio still reuses every
  // request's answer.
  const generator = deps.generator ?? GENERATOR;
  const refusals: Refusal[] = [];
  const refused = (r: Refusal) => {
    refusals.push(r);
    log.warn(`REFUSED: ${refusalLine(r)}`);
  };
  return { media, cfg, deps, log, env, generator, cache, requests, stage, step, refusals, refused };
}
