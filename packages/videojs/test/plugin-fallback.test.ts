// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Player from 'video.js/dist/types/player.js';
import '../src/index';
import { usesNativeTextTracks } from '../src/core/fallback';
import { createTestPlayer, techFullscreen, withUnprefixedFullscreenApi, type TestPlayer } from './player-helpers';
import { loadFixture } from './helpers';

// Pretend native text tracks (as in Safari) unless a test says otherwise; jsdom has none, so the controller
// would skip the fallback tracks.
vi.mock('../src/core/fallback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/fallback')>()),
  usesNativeTextTracks: vi.fn(() => true),
}));

const VTT = 'data:text/vtt,WEBVTT';
const BOTH = { horizontal: VTT, vertical: VTT };

let t: TestPlayer;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(usesNativeTextTracks).mockReturnValue(true);
  t = createTestPlayer();
});

afterEach(() => {
  t.player.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function tracks(player: Player = t.player): TextTrack[] {
  return Array.from(player.textTracks() as unknown as ArrayLike<TextTrack>);
}

function modes(player: Player = t.player): string[] {
  return tracks(player).map((track) => track.mode);
}

describe('iOS native fullscreen fallback', () => {
  it('adds disabled native tracks and shows the active profile track only in iOS native fullscreen', async () => {
    const ctrl = t.overtone({ data: loadFixture(), fallbackTracks: BOTH });
    await ctrl.ready;
    expect(tracks().map((track) => [track.label, track.mode])).toEqual([
      ['English', 'disabled'],
      ['English (phone)', 'disabled'],
    ]);
    t.player.isFullscreen(true); // regular fullscreen: the overlay keeps working
    expect(modes()).toEqual(['disabled', 'disabled']);
    t.player.isFullscreen(false);
    t.player.addClass('vjs-ios-native-fs'); // what video.js does on webkitbeginfullscreen
    t.player.isFullscreen(true);
    expect(modes()).toEqual(['showing', 'disabled']);
    t.player.isFullscreen(false);
    expect(modes()).toEqual(['disabled', 'disabled']);
  });

  it('keeps native tracks hidden when captions are off', async () => {
    const ctrl = t.overtone({ data: loadFixture(), fallbackTracks: { horizontal: VTT }, defaultMode: 'off' });
    await ctrl.ready;
    t.player.addClass('vjs-ios-native-fs');
    t.player.isFullscreen(true);
    expect(modes()).toEqual(['disabled']);
  });

  it('adds no tracks where text tracks are emulated (no native fullscreen captions to back up)', async () => {
    vi.mocked(usesNativeTextTracks).mockReturnValue(false);
    const ctrl = t.overtone({ data: loadFixture(), fallbackTracks: BOTH });
    await ctrl.ready;
    expect(tracks()).toHaveLength(0);
  });

  it('waits for the player to be ready before adding tracks', async () => {
    // A source from the options makes video.js load the tech asynchronously.
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    const late = createTestPlayer({ sources: [{ src: 'clip.mp4', type: 'video/mp4' }] });
    try {
      expect(late.player.tech(true)).toBeUndefined();
      const ctrl = late.overtone({ data: loadFixture(), fallbackTracks: BOTH });
      await ctrl.ready;
      expect(ctrl.error).toBeUndefined();
      await vi.waitFor(() => expect(late.player.tech(true)).toBeTruthy());
      await vi.waitFor(() => expect(modes(late.player)).toEqual(['disabled', 'disabled']));
      // The tech's fullscreen events are followed once the tech exists.
      withUnprefixedFullscreenApi(late.player, () => techFullscreen(late.player, true));
      expect(modes(late.player)).toEqual(['showing', 'disabled']);
    } finally {
      late.player.dispose();
    }
  });

  it('does not add tracks when disposed before the player is ready', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    const late = createTestPlayer({ sources: [{ src: 'clip.mp4', type: 'video/mp4' }] });
    try {
      const ctrl = late.overtone({ data: loadFixture(), fallbackTracks: BOTH });
      await ctrl.ready;
      ctrl.dispose();
      // Ready callbacks run in registration order, so the controller's (now disposed) callback ran before this one.
      await new Promise<void>((resolve) => late.player.ready(() => resolve()));
      expect(late.player.tech(true)).toBeTruthy();
      expect(tracks(late.player)).toHaveLength(0);
    } finally {
      late.player.dispose();
    }
  });

  it('removes its tracks on dispose, so calling overtone() again does not duplicate them', async () => {
    const first = t.overtone({ data: loadFixture(), fallbackTracks: BOTH });
    await first.ready;
    first.dispose();
    expect(t.player.remoteTextTracks()).toHaveLength(0);
    t.overtone({ data: loadFixture(), fallbackTracks: BOTH });
    const second = t.overtone({ data: loadFixture(), fallbackTracks: BOTH });
    await second.ready;
    expect(tracks().map((track) => track.label)).toEqual(['English', 'English (phone)']);
  });

  it("follows the tech's fullscreenchange when the player fires none (unprefixed Fullscreen API)", async () => {
    const ctrl = t.overtone({ data: loadFixture(), fallbackTracks: BOTH });
    await ctrl.ready;
    withUnprefixedFullscreenApi(t.player, () => {
      techFullscreen(t.player, true);
      expect(t.player.hasClass('vjs-ios-native-fs')).toBe(true);
      expect(modes()).toEqual(['showing', 'disabled']);
      techFullscreen(t.player, false);
      expect(modes()).toEqual(['disabled', 'disabled']);
    });
  });

  it('turns off a fallback track that the browser shows on its own', async () => {
    const ctrl = t.overtone({ data: loadFixture(), fallbackTracks: BOTH });
    await ctrl.ready;
    tracks()[0].mode = 'showing'; // e.g. WebKit auto-selecting captions from accessibility settings
    // video.js fires the list's `change` asynchronously
    await vi.waitFor(() => expect(modes()).toEqual(['disabled', 'disabled']));
  });

  it("respects the viewer's caption choice in the native menu during iOS native fullscreen", async () => {
    const ctrl = t.overtone({ data: loadFixture(), fallbackTracks: BOTH });
    await ctrl.ready;
    t.player.addClass('vjs-ios-native-fs');
    t.player.isFullscreen(true);
    expect(modes()).toEqual(['showing', 'disabled']);
    const changed = new Promise((resolve) => t.player.textTracks().addEventListener('change', resolve, { once: true }));
    tracks()[0].mode = 'disabled'; // the viewer turns captions off in the native player
    await changed; // FallbackSync's listener was registered first, so it has run
    expect(modes()).toEqual(['disabled', 'disabled']);
    expect(ctrl.getMode()).toBe('styled');
    expect(localStorage.getItem('overtone-caption-mode')).toBeNull();
    t.player.isFullscreen(false);
    t.player.removeClass('vjs-ios-native-fs');
    t.player.addClass('vjs-ios-native-fs');
    t.player.isFullscreen(true); // entering native fullscreen again applies the overlay's mode
    expect(modes()).toEqual(['showing', 'disabled']);
  });
});
