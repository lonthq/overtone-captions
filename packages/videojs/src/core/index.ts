// videojs-overtone/core: the caption rendering without video.js (used by overtone burn and the style gallery).
export { cueIndexAt } from './cue-at.js';
export { cueIndexWithHold, CUE_HOLD_SECONDS } from './cue-hold.js';
export { applyProfileToLayer, classToken } from './layer.js';
export { pictureRect, type Rect } from './picture.js';
export { chooseProfile, type Size } from './profile.js';
export { renderCue, shouldShowSpeaker, turnOf, updateActiveWords, wordsOf, type RenderOptions } from './render.js';
export { isInWindow } from './window.js';
export type { CaptionMode, SpeakerDisplay } from '../types.js';
