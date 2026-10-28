import videojs from 'video.js';
import type { Player } from './video-types.js';
import { OvertoneController } from './controller.js';
import type { OvertoneOptions } from './types.js';

const controllers = new WeakMap<Player, OvertoneController>();

/** `player.overtone(options)`: returns the controller; a second call replaces the previous overlay. */
export function overtonePlugin(this: Player, options: OvertoneOptions = {}): OvertoneController {
  controllers.get(this)?.dispose();
  const controller = new OvertoneController(this, options);
  controllers.set(this, controller);
  return controller;
}

/**
 * Registers the 'overtone' plugin (idempotent). The button is not a registered component: one video.js made by name
 * would control nothing.
 */
export function registerOvertone(): void {
  if (!videojs.getPlugin('overtone')) videojs.registerPlugin('overtone', overtonePlugin);
}
