import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { binaryPath } from '../src/providers/whisper-cpp.js';

describe('WHISPER_CPP_BIN as spawned', () => {
  it('expands "~/" and resolves a relative path, as preflight checks it (spawn does no shell expansion)', () => {
    expect(binaryPath({ WHISPER_CPP_BIN: '~/whisper.cpp/build/bin/whisper-cli' }, '/work')).toBe(join(homedir(), 'whisper.cpp/build/bin/whisper-cli'));
    expect(binaryPath({ WHISPER_CPP_BIN: 'build/bin/whisper-cli' }, '/work')).toBe('/work/build/bin/whisper-cli');
    expect(binaryPath({ WHISPER_CPP_BIN: '/opt/whisper-cli' }, '/work')).toBe('/opt/whisper-cli');
  });

  it('keeps a bare name for a PATH lookup', () => {
    expect(binaryPath({}, '/work')).toBe('whisper-cli');
    expect(binaryPath({ WHISPER_CPP_BIN: ' whisper-cli ' }, '/work')).toBe('whisper-cli');
  });
});
