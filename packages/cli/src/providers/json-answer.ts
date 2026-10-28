// Asking for JSON and reading it back, for OpenAI chat API providers (openai, azure-openai, ollama).
import { envEnum } from './kit.js';

/**
 * - `json_schema` (default): strict `response_format`; the server enforces the schema.
 * - `json_object`: the schema goes in the system prompt, for OpenAI-compatible servers without JSON-schema support.
 * `withSchemaValidation` checks the answer either way.
 */
export type ResponseFormat = 'json_schema' | 'json_object';
export const RESPONSE_FORMATS: readonly ResponseFormat[] = ['json_schema', 'json_object'];

/** The `json_object` system prompt: spells out the schema the server does not enforce. */
export function jsonObjectSystem(system: string, schema: unknown): string {
  return `${system}\n\nAnswer with one JSON object, and nothing else, that matches this JSON schema exactly:\n${JSON.stringify(schema)}`;
}

/**
 * The JSON part of a message: trimmed, minus a leading <think>…</think> block (e.g. Qwen3 on Ollama puts it in
 * `content`) and a ```json fence (json_object mode on some servers). JSON.parse judges the rest.
 */
export function jsonContent(content: string | null | undefined): string {
  let c = (content ?? '').trim();
  c = c.replace(/^<think>[\s\S]*?<\/think>\s*/, '');
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(c);
  return (fence ? fence[1]! : c).trim();
}

/** `<PREFIX>_RESPONSE_FORMAT`: json_schema (default) or json_object; else a user error. */
export function responseFormatFrom(env: NodeJS.ProcessEnv, name: string): ResponseFormat {
  return envEnum(env, name, RESPONSE_FORMATS) ?? 'json_schema';
}
