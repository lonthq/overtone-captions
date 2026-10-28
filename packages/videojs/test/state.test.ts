// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODES, modeLabel, nextMode, readStoredMode, storeMode } from '../src/core/state';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('mode cycle', () => {
  it('cycles off → styled → plain → off', () => {
    expect(MODES).toEqual(['off', 'styled', 'plain']);
    expect(nextMode('off')).toBe('styled');
    expect(nextMode('styled')).toBe('plain');
    expect(nextMode('plain')).toBe('off');
  });

  it('labels each mode for the toast and the button', () => {
    expect(modeLabel('off')).toBe('Captions: off');
    expect(modeLabel('styled')).toBe('Captions: styled');
    expect(modeLabel('plain')).toBe('Captions: plain');
  });
});

describe('stored mode', () => {
  it('round-trips through localStorage', () => {
    storeMode('k', 'plain');
    expect(localStorage.getItem('k')).toBe('plain');
    expect(readStoredMode('k', 'styled')).toBe('plain');
  });

  it('falls back when nothing or garbage is stored', () => {
    expect(readStoredMode('missing', 'styled')).toBe('styled');
    localStorage.setItem('k', 'loud');
    expect(readStoredMode('k', 'off')).toBe('off');
  });

  it('works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => storeMode('k', 'plain')).not.toThrow();
    expect(readStoredMode('k', 'styled')).toBe('styled');
  });

  it('works when localStorage does not exist', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => storeMode('k', 'plain')).not.toThrow();
    expect(readStoredMode('k', 'plain')).toBe('plain');
  });
});
