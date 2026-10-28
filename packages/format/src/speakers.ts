import { cleanText } from './export/shared.js';
import type { OvertoneDocument } from './types.js';

/** Display name of a speaker: its label, else its id (whitespace collapsed and trimmed in both). */
export function speakerLabel(doc: OvertoneDocument, speakerId: string): string {
  const label = doc.speakers.find((speaker) => speaker.id === speakerId)?.label;
  return cleanText(label ?? '') || cleanText(speakerId);
}
