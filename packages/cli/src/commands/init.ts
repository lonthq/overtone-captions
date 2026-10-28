import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULTS, validateFileConfig, type FileConfig } from '../config.js';
import { UserError } from '../errors.js';
import { defaultSelectionId } from '../providers/registry.js';
import type { Logger } from '../log.js';
import { LATEST, RULESETS } from '../segment/rulesets/index.js';

export interface InitFlags { force?: boolean }

/**
 * Model ids `overtone init` writes. OpenAI lists no dated snapshots of gpt-transcribe or gpt-6.1-sol, so both stay
 * undated and the file says so; an Azure OpenAI deployment pins its version on the Azure side. Azure Speech has no
 * model choice: its API version is fixed in the code.
 */
export const INIT_MODELS = {
  text: defaultSelectionId('text'),
  timing: DEFAULTS.timing,
  llm: defaultSelectionId('llm'),
} as const;

/** The overtone.config.json `overtone init` writes: the current defaults, pinned. */
export function initConfig(): FileConfig & Record<`$${string}`, unknown> {
  const ruleset = RULESETS[LATEST];
  return {
    $comment: [
      'Written by `overtone init`: today\'s defaults, pinned, so a later run or a CLI upgrade cuts the same words into the same captions.',
      `rules: rule set ${ruleset.id}, the rule-based caption layout. "latest" follows upgrades instead. See "Stable output: rule sets" in the overtone-captions README.`,
      'text, llm: OpenAI has no dated ids for these models yet, so OpenAI may update them; replace them with dated ids when they exist (an Azure OpenAI deployment pins a model version). Transcription and LLM output also vary from run to run.',
      'llmLinebreaks: false = captions and lines are cut by the rules alone; true = the LLM also proposes breaks (checked by the rules).',
      'profiles: not pinned, so a video also gets a profile for its own shape; set a list (names and aspects such as "1:1") to choose exactly.',
      'profileRules: the built-in profiles of this rule set; change them freely, or define a profile here with an "aspect"; rules given here win, so remove one to derive it from the aspect.',
    ],
    rules: ruleset.id,
    text: INIT_MODELS.text,
    timing: INIT_MODELS.timing,
    llm: INIT_MODELS.llm,
    llmLinebreaks: DEFAULTS.llmLinebreaks,
    profileRules: Object.fromEntries(Object.entries(ruleset.profiles).map(([id, p]) => [id, { description: p.description, aspect: p.aspect, rules: { ...p.rules } }])),
  };
}

/** `overtone init`: write overtone.config.json in `cwd` (no overwrite without --force). Returns the exit code. */
export async function runInit(flags: InitFlags, log: Logger, cwd = process.cwd()): Promise<number> {
  const file = resolve(cwd, 'overtone.config.json');
  if (existsSync(file) && !flags.force) throw new UserError(`${file} already exists; use --force to overwrite it.`);
  const config = initConfig();
  const text = `${JSON.stringify(config, null, 2)}\n`;
  validateFileConfig(JSON.parse(text), 'overtone.config.json');
  await writeFile(file, text, 'utf8');
  log.out(file);
  log.info(`rules pinned to rule set ${config.rules}; models ${config.text}, ${config.timing}, ${config.llm}`);
  return 0;
}
