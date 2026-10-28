import type { Logger } from '../log.js';
import { LlmFormatError, type JsonSchema, type LlmProvider, type LlmRequest } from './types.js';

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return true;
  }
}

const KEYWORDS = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'description', 'title']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const SUPPORTED = [...KEYWORDS].join(', ');

/** Throws when `schema` uses anything `checkSchema` cannot verify, so validation is never silently lost. */
export function assertSupportedSchema(schema: JsonSchema, path = '$'): void {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`checkSchema: unsupported schema keyword "${key}" at ${path} (supported: ${SUPPORTED})`);
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  for (const t of types) if (!TYPES.has(t)) throw new Error(`checkSchema: unsupported schema type "${String(t)}" at ${path}`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    throw new Error(`checkSchema: unsupported additionalProperties at ${path} (only true or false)`);
  }
  for (const [key, sub] of Object.entries((schema.properties as Record<string, JsonSchema> | undefined) ?? {})) {
    assertSupportedSchema(sub, `${path}.${key}`);
  }
  if (schema.items) assertSupportedSchema(schema.items as JsonSchema, `${path}[]`);
}

function check(schema: JsonSchema, value: unknown, path: string): string[] {
  const issues: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  if (types.length > 0 && !types.some((t) => typeOk(t, value))) return [`${path}: expected ${types.join(' | ')}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: must be one of ${JSON.stringify(schema.enum)}`];
  if (typeOk('object', value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!Object.hasOwn(obj, key)) issues.push(`${path}.${key}: missing`);
    for (const [key, v] of Object.entries(obj)) {
      if (Object.hasOwn(props, key)) issues.push(...check(props[key]!, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push(`${path}.${key}: unexpected property`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => issues.push(...check(schema.items as JsonSchema, item, `${path}[${i}]`)));
  }
  return issues;
}

/**
 * Checks `value` against the JSON Schema subset our prompts use: type, enum, properties, required,
 * additionalProperties (boolean), items; description and title are ignored. Returns readable issues.
 */
export function checkSchema(schema: JsonSchema, value: unknown, path = '$'): string[] {
  assertSupportedSchema(schema, path);
  return check(schema, value, path);
}

/** Validates every LLM response against the request schema; retries once on a mismatch. */
export function withSchemaValidation(llm: LlmProvider, log?: Logger): LlmProvider {
  const attempt = async (req: LlmRequest): Promise<{ value?: unknown; issues: string[] }> => {
    try {
      const value = await llm.complete<unknown>(req);
      return { value, issues: checkSchema(req.schema, value) };
    } catch (err) {
      if (err instanceof LlmFormatError) {
        if (err.truncated || /cut off|max[_ ]tokens/i.test(err.message)) {
          // some providers name their own limit to raise (OLLAMA_MAX_TOKENS, OLLAMA_NUM_CTX); otherwise reasoning
          // tokens crowded out the answer
          const fix = /\braise\b/.test(err.message) ? '' : ' A lower reasoning effort for this step ("effort" in overtone.config.json) leaves more room for the answer.';
          throw new Error(`${req.name}: ${err.message}; the answer did not fit the token limit, so retrying would not help.${fix}`);
        }
        return { issues: [err.message] };
      }
      throw err;
    }
  };
  return {
    id: llm.id,
    ...(llm.cacheWarmupMs ? { cacheWarmupMs: llm.cacheWarmupMs } : {}),
    ...(llm.settings ? { settings: llm.settings } : {}),
    ...(llm.uncached ? { uncached: llm.uncached } : {}),
    async complete<T>(req: LlmRequest): Promise<T> {
      assertSupportedSchema(req.schema);
      const first = await attempt(req);
      if (first.issues.length === 0) return first.value as T;
      log?.warn(`${req.name}: response did not match the schema (${first.issues[0]}); retrying once`);
      const retry = await attempt({
        ...req,
        user: `${req.user}\n\nYour previous answer was invalid: ${first.issues.slice(0, 5).join('; ')}. Answer again and follow the JSON schema exactly.`,
      });
      if (retry.issues.length === 0) return retry.value as T;
      throw new Error(`${req.name}: LLM response does not match the schema after one retry: ${retry.issues.slice(0, 5).join('; ')}`);
    },
  };
}
