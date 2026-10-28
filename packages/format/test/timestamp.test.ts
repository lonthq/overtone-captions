import { describe, expect, it } from 'vitest';
import { formatTimestamp, roundTime } from 'overtone-format';

describe('formatTimestamp', () => {
  it('formats hh:mm:ss.mmm for WebVTT and hh:mm:ss,mmm for SRT', () => {
    expect(formatTimestamp(0, '.')).toBe('00:00:00.000');
    expect(formatTimestamp(12.34, '.')).toBe('00:00:12.340');
    expect(formatTimestamp(12.34, ',')).toBe('00:00:12,340');
  });

  it('handles minutes and hours', () => {
    expect(formatTimestamp(3725.046, '.')).toBe('01:02:05.046');
    expect(formatTimestamp(36000, ',')).toBe('10:00:00,000');
  });

  it('rounds to the nearest millisecond and carries over', () => {
    expect(formatTimestamp(59.9996, '.')).toBe('00:01:00.000');
    expect(formatTimestamp(1.0004, '.')).toBe('00:00:01.000');
  });
});

describe('roundTime', () => {
  it('rounds seconds to 3 decimals', () => {
    expect(roundTime(1.23456)).toBe(1.235);
    expect(roundTime(0.1 + 0.2)).toBe(0.3);
  });
});
