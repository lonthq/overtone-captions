import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { ROLES } from '../providers/kit.js';
import { getProvider, providers } from '../providers/registry.js';

const GUIDE = 'https://github.com/lonthq/overtone-captions/blob/main/docs/contributing/providers.md';

/** `overtone providers [id]`: every provider with its roles and defaults, or the environment of one. No API calls. */
export function runProviders(id: string | undefined, log: Logger): number {
  if (id === undefined) {
    const all = providers();
    const width = Math.max(...all.map((d) => d.id.length)) + 2;
    log.out(`${'provider'.padEnd(width)}${'roles'.padEnd(20)}defaults`);
    for (const d of all) {
      const defaults = ROLES.filter((r) => d.defaults[r]).map((r) => `${r} ${d.defaults[r]}`).join(', ') || '(model part required)';
      log.out(`${d.id.padEnd(width)}${d.roles.join(', ').padEnd(20)}${defaults}`);
    }
    log.out('');
    log.out('Environment of one provider: overtone providers <id>. Add a provider: ' + GUIDE);
    return 0;
  }
  const d = getProvider(id.trim().toLowerCase());
  if (!d) throw new UserError(`Unknown provider "${id}"; known: ${providers().map((p) => p.id).join(', ')}.`);
  log.out(`${d.id}: ${d.description}`);
  log.out(`  roles: ${d.roles.join(', ')}${d.wordTimings === true ? ' (text with word timings: --timing same works)' : d.wordTimings ? ` (text with word timings for ${d.wordTimings.join(', ')}: --timing same works)` : ''}`);
  for (const r of d.roles) log.out(`  ${r}: ${d.defaults[r] ? `default model ${d.defaults[r]}` : `model part required (${d.modelHint ?? 'provider:model'})`}`);
  if (d.env.length === 0) log.out('  environment: none');
  for (const v of d.env) {
    const need = v.required ? (v.waivedBy ? `required unless ${v.waivedBy} is set` : 'required') : 'optional';
    log.out(`  ${v.name} (${need}${v.secret ? ', secret' : ''}): ${v.description}`);
  }
  return 0;
}
