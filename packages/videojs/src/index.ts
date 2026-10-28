import { OvertoneController } from './controller.js';
import { registerOvertone } from './plugin.js';
import type { OvertoneOptions } from './types.js';

registerOvertone();

// Adds `player.overtone(options)` to video.js's Player type.
declare module 'video.js/dist/types/player.js' {
  export default interface Player {
    overtone(options?: OvertoneOptions): OvertoneController;
  }
}

// Caption rendering without video.js is in 'videojs-overtone/core'.
export { OvertoneController };
export { OvertoneCaptionsButton, type CaptionsButtonOptions } from './components/CaptionsButton.js';
export { overtonePlugin, registerOvertone } from './plugin.js';
export type { CaptionMode, OvertoneOptions, SpeakerDisplay } from './types.js';
