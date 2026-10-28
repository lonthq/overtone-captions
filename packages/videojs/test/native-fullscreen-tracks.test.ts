// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { createTestPlayer, techFullscreen, withUnprefixedFullscreenApi, type TestPlayer } from './player-helpers';
import { loadFixture } from './helpers';

// Pretend native text tracks (as in Safari), where iOS native fullscreen shows the native captions menu.
vi.mock('../src/core/fallback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/fallback')>()),
  usesNativeTextTracks: () => true,
}));

let t: TestPlayer;

beforeEach(() => {
  localStorage.clear();
  t = createTestPlayer();
});

afterEach(() => {
  t.player.dispose();
  vi.restoreAllMocks();
});

function pageTrack(mode: TextTrackMode = 'disabled'): TextTrack {
  const el = t.player.addRemoteTextTrack({ kind: 'captions', src: 'data:text/vtt,WEBVTT', srclang: 'en', label: 'English', mode }, false);
  return (el as unknown as { track: TextTrack }).track;
}

/** Turns a track on as the viewer does in the native captions menu, and waits for video.js's queued `change`. */
async function viewerTurnsOn(track: TextTrack): Promise<void> {
  const changed = new Promise((resolve) => t.player.textTracks().addEventListener('change', resolve, { once: true }));
  track.mode = 'showing';
  await changed;
}

describe("the page's caption tracks and iOS native fullscreen", () => {
  it('turns off a page track the viewer turned on in native fullscreen when that fullscreen ends', async () => {
    const track = pageTrack();
    await t.overtone({ data: loadFixture() }).ready;
    t.player.addClass('vjs-ios-native-fs'); // what video.js does on webkitbeginfullscreen
    t.player.isFullscreen(true);
    await viewerTurnsOn(track);
    expect(track.mode).toBe('showing'); // the native menu is the viewer's only control there
    t.player.isFullscreen(false);
    expect(track.mode).toBe('disabled');
  });

  it("follows the tech's fullscreenchange when the player fires none (unprefixed Fullscreen API)", async () => {
    const track = pageTrack();
    await t.overtone({ data: loadFixture() }).ready;
    withUnprefixedFullscreenApi(t.player, () => techFullscreen(t.player, true));
    expect(t.player.hasClass('vjs-ios-native-fs')).toBe(true);
    await viewerTurnsOn(track);
    expect(track.mode).toBe('showing');
    withUnprefixedFullscreenApi(t.player, () => techFullscreen(t.player, false));
    expect(track.mode).toBe('disabled');
  });

  it('leaves the track alone after the document failed to load', async () => {
    const track = pageTrack();
    const ctrl = t.overtone({ data: { format: 'nope' } as never });
    await ctrl.ready;
    expect(ctrl.error).toBeDefined();
    t.player.addClass('vjs-ios-native-fs');
    t.player.isFullscreen(true);
    await viewerTurnsOn(track);
    t.player.isFullscreen(false);
    expect(track.mode).toBe('showing');
  });

  it('leaves the track alone after a manual dispose', async () => {
    const track = pageTrack();
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    ctrl.dispose();
    t.player.addClass('vjs-ios-native-fs');
    t.player.isFullscreen(true);
    track.mode = 'showing';
    t.player.isFullscreen(false);
    withUnprefixedFullscreenApi(t.player, () => techFullscreen(t.player, false));
    expect(track.mode).toBe('showing');
  });
});
