import { EDIT_REASONS, STYLE_CLASSES, type EditReason, type StyleClass } from 'overtone-format';
import type { JsonSchema } from '../providers/types.js';

/** Strict-mode friendly (OpenAI and Anthropic): every property required, no additional properties. */
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const int = { type: 'integer' };

export const CORRECTIONS_SCHEMA: JsonSchema = obj({
  edits: { type: 'array', items: obj({ first: int, last: int, to: { type: 'string' }, reason: { type: 'string', enum: [...EDIT_REASONS] }, sure: { type: 'boolean' }, note: { type: 'string' } }) },
  speakers: { type: 'array', items: obj({ id: { type: 'string' }, label: { type: 'string' }, role: { type: 'string' } }) },
});
export interface CorrectionsResponse {
  edits: Array<{ first: number; last: number; to: string; reason: EditReason; sure: boolean; note: string }>;
  speakers: Array<{ id: string; label: string; role: string }>;
}

export const STYLING_SCHEMA: JsonSchema = obj({
  styles: { type: 'array', items: obj({ first: int, last: int, classes: { type: 'array', items: { type: 'string', enum: [...STYLE_CLASSES] } } }) },
});
export interface StylingResponse { styles: Array<{ first: number; last: number; classes: StyleClass[] }> }

export const LINEBREAKS_SCHEMA: JsonSchema = obj({
  cueStarts: { type: 'array', items: int },
  lineStarts: { type: 'array', items: int },
});
export interface LinebreaksResponse { cueStarts: number[]; lineStarts: number[] }
