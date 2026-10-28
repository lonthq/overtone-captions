import { validate, type OvertoneDocument } from 'overtone-format';
import { UserError } from './errors.js';

/** `value` as an Overtone document, or a UserError that names the file as `shown` and lists every issue. */
export function assertDocument(value: unknown, shown: string): OvertoneDocument {
  const result = validate(value);
  if (!result.valid) {
    throw new UserError(`${shown} is not a valid Overtone document:\n${result.errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n')}`);
  }
  return value as OvertoneDocument;
}
