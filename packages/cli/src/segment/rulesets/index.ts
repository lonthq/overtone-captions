import { UserError } from '../../errors.js';
import { languageDataHash } from '../../lang/fingerprint.js';
import { RULESET_1 } from './1.js';
import type { RuleSet } from './types.js';

export type { RuleSet } from './types.js';

/** Every released rule set by id. Each release keeps the earlier ones, so a pinned id gives the same layout. */
export const RULESETS: Readonly<Record<string, RuleSet>> = Object.freeze({ '1': RULESET_1 });

/** The rule set `"rules": "latest"` (the default) resolves to. */
export const LATEST = '1';

/** The latest rule set: the default where no rule set is passed. */
export const LATEST_RULESET: RuleSet = RULESETS[LATEST];

/** The rule set for `id` ("1", or "latest"/undefined for LATEST); an unknown id is a UserError listing the known ones. */
export function resolveRuleSet(id: string | undefined, source = '--rules'): RuleSet {
  const key = id === undefined || id.trim().toLowerCase() === 'latest' ? LATEST : id.trim();
  if (!Object.hasOwn(RULESETS, key)) {
    throw new UserError(`Unknown rule set "${id}" in ${source}; available: ${Object.keys(RULESETS).join(', ')} or "latest" (= ${LATEST}).`);
  }
  return RULESETS[key];
}

/**
 * What a document records about its layout: `meta.rules` (rule set id) and `meta.languageData` (languageDataHash,
 * for reproducibility only; no cache key uses it).
 */
export function layoutMeta(ruleset: RuleSet, language: string | undefined): { rules: string; languageData: string } {
  return { rules: ruleset.id, languageData: languageDataHash(language) };
}
