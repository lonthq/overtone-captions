import { vi } from 'vitest';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player.js';
import type { OvertoneController, OvertoneOptions } from '../src/index';

// jsdom logs "Not implemented" on every media load() call; a no-op keeps the output readable.
HTMLMediaElement.prototype.load = () => undefined;

// Captured before any spy, so `setVideo` can be called repeatedly without its spy calling itself.
const realGetComputedStyle = window.getComputedStyle.bind(window);

/** A real video.js player (with controls) on a fresh <video> element in jsdom; `options` go to video.js. */
export function createPlayer(options: Record<string, unknown> = {}): Player {
  const video = document.createElement('video');
  document.body.append(video);
  return videojs(video, { controls: true, ...options });
}

/** A player with a typed `overtone()` plus helpers to fake the media time and the player size. */
export interface TestPlayer {
  player: Player;
  overtone: (options?: OvertoneOptions) => OvertoneController;
  /** Pretends the media is at `seconds` and fires `timeupdate`. */
  seek: (seconds: number) => void;
  /** Pretends the player has this on-screen size and fires `playerresize`. */
  resize: (width: number, height: number) => void;
  /** Pretends the video has this intrinsic size (and object-fit) and fires `loadedmetadata`. */
  setVideo: (width: number, height: number, fit?: string) => void;
}

export function createTestPlayer(options: Record<string, unknown> = {}): TestPlayer {
  const player = createPlayer(options);
  let time = 0;
  vi.spyOn(player, 'currentTime').mockImplementation(() => time);
  vi.spyOn(player.log, 'error').mockImplementation(() => undefined);
  return {
    player,
    overtone: (options) => (player as unknown as { overtone: TestPlayer['overtone'] }).overtone(options),
    seek: (seconds) => {
      time = seconds;
      player.trigger('timeupdate');
    },
    resize: (width, height) => {
      vi.spyOn(player.el(), 'getBoundingClientRect').mockReturnValue({ width, height } as DOMRect);
      player.trigger('playerresize');
    },
    setVideo: (width, height, fit = 'contain') => {
      const video = player.el().querySelector('video')!;
      Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => width });
      Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => height });
      // jsdom does not compute object-fit; answer it for this element only.
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
        el === video ? ({ objectFit: fit } as CSSStyleDeclaration) : realGetComputedStyle(el, pseudo));
      player.trigger('loadedmetadata');
    },
  };
}

/** What video.js's Html5 tech fires on webkitbeginfullscreen / webkitendfullscreen. */
export function techFullscreen(player: Player, isFullscreen: boolean): void {
  player.tech(true).trigger('fullscreenchange', isFullscreen ? { isFullscreen, nativeIOSFullscreen: true } : { isFullscreen });
}

/**
 * Runs `fn` as if the browser had the unprefixed Fullscreen API (iPadOS): video.js then fires no
 * player-level `fullscreenchange` when the tech reports native video fullscreen.
 */
export function withUnprefixedFullscreenApi(player: Player, fn: () => void): void {
  const fsApi = (player as unknown as { fsApi_: { prefixed: boolean } }).fsApi_;
  const prefixed = fsApi.prefixed;
  fsApi.prefixed = false;
  try {
    fn();
  } finally {
    fsApi.prefixed = prefixed;
  }
}

/** The visible caption text of a layer: its lines joined by " / ". */
export function captionText(layer: HTMLElement): string {
  return [...layer.querySelectorAll('.ot-line')].map((line) => line.textContent).join(' / ');
}
