// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom does not load media; a no-op keeps video.js's load() calls quiet.
HTMLMediaElement.prototype.load = () => undefined;

type Source = { src: string; type: string };
type RetryOnMediaError = (player: Player, source: Source, onGiveUp: (error: { code: number }) => void) => void;

// media-retry.js is a classic browser script (a global function, no exports): run it the way the page does.
// import.meta.dirname rather than new URL(): under jsdom, URL is jsdom's class, which node:fs rejects.
const retryOnMediaError = new Function(
  `${readFileSync(join(import.meta.dirname, '../media-retry.js'), 'utf8')}\nreturn retryOnMediaError;`,
)() as RetryOnMediaError;

const SOURCE: Source = { src: 'https://download.example.org/film.mov', type: 'video/mp4' };

let player: Player;
let time: number;
let setSource: ReturnType<typeof vi.fn>;
let onGiveUp: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const video = document.createElement('video');
  document.body.append(video);
  player = videojs(video);
  time = 0;
  vi.spyOn(player, 'currentTime').mockImplementation((seconds?: number | string) => {
    if (seconds !== undefined) time = Number(seconds);
    return time;
  });
  // jsdom has no tech that plays video/mp4: setting a real source would end in video.js's own error.
  setSource = vi.fn();
  vi.spyOn(player, 'src').mockImplementation(setSource);
  vi.spyOn(player.log, 'error').mockImplementation(() => undefined);
  onGiveUp = vi.fn();
  retryOnMediaError(player, SOURCE, onGiveUp);
});

afterEach(() => {
  player.dispose();
});

describe('retryOnMediaError', () => {
  it('clears the first media error and loads the same source again', () => {
    player.error({ code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' });
    expect(setSource).toHaveBeenCalledExactlyOnceWith(SOURCE);
    expect(player.error()).toBeNull();
    expect(player.hasClass('vjs-error')).toBe(false);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('resumes at the position where the video failed', () => {
    time = 42;
    player.error({ code: 2, message: 'MEDIA_ERR_NETWORK' });
    time = 0; // the new load starts at 0
    player.trigger('loadedmetadata');
    expect(time).toBe(42);
  });

  it('gives up on the second error without loading again', () => {
    player.error({ code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' });
    player.error({ code: 3, message: 'MEDIA_ERR_DECODE' });
    expect(setSource).toHaveBeenCalledOnce();
    expect(onGiveUp).toHaveBeenCalledOnce();
    expect(onGiveUp.mock.calls[0][0].code).toBe(3);
    // The second error stays on the player, so video.js shows its error overlay.
    expect(player.error()?.code).toBe(3);
  });

  it('does not count an aborted load as a failure', () => {
    player.error({ code: 1, message: 'MEDIA_ERR_ABORTED' });
    expect(setSource).not.toHaveBeenCalled();
    player.error({ code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' });
    expect(setSource).toHaveBeenCalledOnce();
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});
