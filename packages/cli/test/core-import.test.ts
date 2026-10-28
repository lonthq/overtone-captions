import { describe, expect, it } from 'vitest';
import { cueIndexAt } from 'videojs-overtone/core';

describe('videojs-overtone/core', () => {
  it('resolves from the CLI package', () => expect(typeof cueIndexAt).toBe('function'));
});
