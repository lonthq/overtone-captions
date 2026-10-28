import type { OvertoneDocument } from 'overtone-format';

export type CaptionMode = 'off' | 'styled' | 'plain';
export type SpeakerDisplay = 'change' | 'always' | 'never';

export interface OvertoneOptions {
  src?: string;                 // URL of .overtone.json
  data?: OvertoneDocument;      // or inline document
  profile?: 'auto' | string;    // default 'auto'
  theme?: string;               // default 'clean' → root class `ot-theme-clean`
  speakers?: SpeakerDisplay;    // default 'never' (names hidden unless enabled)
  fallbackTracks?: Record<string, string>;  // profileId → .vtt URL (iOS native fullscreen)
  storageKey?: string;          // default 'overtone-caption-mode'
  defaultMode?: CaptionMode;    // default 'styled'
}
