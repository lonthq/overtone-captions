import { resolve } from 'node:path';
import { loadConfigFile, loadEnv, resolveConfig, type CliFlags } from '../config.js';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { runPipeline, type PipelineDeps } from '../pipeline.js';
import { configFilePath, envFilePath, formatPlan, planRun } from '../pipeline/plan.js';
import { reportRefusals } from '../refusals.js';
import { reportReview } from '../review.js';

/** `--dry-run`: print what the run would do and stop (no provider request, extraction, cache or output). */
export type TranscribeFlags = CliFlags & { dryRun?: boolean };

/** `overtone transcribe <media>`: config → pipeline → written files + summary. Returns the exit code. */
export async function runTranscribe(media: string, flags: TranscribeFlags, log: Logger, deps: Partial<PipelineDeps> = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  if (!deps.env) loadEnv(cwd);
  const file = await loadConfigFile(flags.config, cwd, (msg) => log.warn(msg));
  const cfg = await resolveConfig(flags, file.config, { cwd, configDir: file.dir }, (msg) => log.warn(msg));
  if (flags.dryRun) {
    const plan = await planRun(resolve(cwd, media), cfg, { ...deps, cwd, log }, deps.env ?? process.env, { configFile: configFilePath(flags.config, cwd), envFile: envFilePath(cwd) });
    for (const line of formatPlan(plan)) log.out(line);
    // not runnable (missing keys, no ffmpeg, too long): exit code 1 with the message the real run would stop with
    if (plan.problems.length > 0) throw new UserError(plan.problems.join('\n'));
    return 0;
  }
  const res = await runPipeline(resolve(cwd, media), cfg, { ...deps, cwd, log });
  for (const p of res.written) log.out(p);
  // usage first so the summary stays the final line, unless a REFUSED block follows it
  if (res.usageLine) log.info(res.usageLine);
  reportReview(res.review, log);
  log.info(res.summary);
  reportRefusals(res.refusals, log);
  return 0;
}
