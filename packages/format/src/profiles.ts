import type { ProfileRules } from './types.js';

export const DEFAULT_PROFILES: Record<'horizontal' | 'vertical', { description: string; aspect: string; rules: ProfileRules }> = {
  horizontal: { description: 'TV/desktop', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2, maxCps: 17, minDuration: 1.0, maxDuration: 7.0 } },
  vertical:   { description: 'Phone',      aspect: '9:16', rules: { maxCharsPerLine: 22, maxLines: 2, maxCps: 15, minDuration: 0.8, maxDuration: 5.0 } },
};
