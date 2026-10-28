import { describe, expect, it } from 'vitest';
import { toPlayerDocument, validate } from 'overtone-format';
import { makeDoc } from './helpers';

describe('toPlayerDocument', () => {
  it('keeps what the player reads and leaves out meta, edits and the words\' match and confidence', () => {
    const doc = makeDoc();
    const player = toPlayerDocument(doc);
    expect(player.meta).toBeUndefined();
    expect(player.edits).toBeUndefined();
    expect(player.turns[0]!.words[2]).toEqual({ text: 'welcome', start: 1.45, end: 1.8, classes: ['emphasis'] });
    expect(player.speakers).toEqual(doc.speakers);
    expect(player.profiles).toEqual(doc.profiles);
    expect(validate(player)).toEqual(expect.objectContaining({ valid: true }));
    // the input is not changed
    expect(doc.turns[0]!.words[2]!.match).toBe('fuzzy');
  });

  it('keeps only the chosen profiles, and rejects an unknown one', () => {
    expect(toPlayerDocument(makeDoc(), { profiles: ['vertical'] }).profiles.map((p) => p.id)).toEqual(['vertical']);
    expect(() => toPlayerDocument(makeDoc(), { profiles: ['square'] })).toThrow('Unknown profile "square"');
  });
});
