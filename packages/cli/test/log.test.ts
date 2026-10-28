import { describe, expect, it } from 'vitest';
import { debugEnabled, memoryLogger } from '../src/log.js';

describe('debug logging', () => {
  it('is on when OVERTONE_DEBUG is set to anything but "", "0" or "false"', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE']) expect(debugEnabled({ OVERTONE_DEBUG: v })).toBe(true);
    for (const v of [undefined, '', ' ', '0', 'false', 'False']) expect(debugEnabled({ OVERTONE_DEBUG: v })).toBe(false);
  });

  it('memoryLogger records debug lines only when asked', () => {
    const quiet = memoryLogger();
    quiet.debug('x');
    expect(quiet.lines).toEqual([]);
    const loud = memoryLogger({ debug: true });
    loud.debug('x');
    expect(loud.lines).toEqual(['debug: x']);
  });
});
