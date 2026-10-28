// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Player from 'video.js/dist/types/player.js';
import {
  addFallbackTracks,
  fallbackLabel,
  isNativeIOSFullscreen,
  removeFallbackTracks,
  syncFallbackTracks,
  usesNativeTextTracks,
} from '../src/core/fallback';
import { createPlayer } from './player-helpers';

// data: URLs so video.js can "load" the tracks in jsdom without network errors.
const VTT = 'data:text/vtt,WEBVTT';
// jsdom reports no playable types; without this video.js never applies a source to the tech.
HTMLMediaElement.prototype.canPlayType = () => 'maybe';
let player: Player | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  player?.dispose();
  player = undefined;
});

function makePlayer(): Player {
  player = createPlayer();
  return player;
}

describe('fallback tracks', () => {
  it('adds one disabled captions track per profile', () => {
    const tracks = addFallbackTracks(makePlayer(), 'en', { horizontal: VTT, vertical: VTT });
    expect(tracks.map((t) => t.profileId)).toEqual(['horizontal', 'vertical']);
    expect(tracks.map((t) => [t.track.kind, t.track.language, t.track.label, t.track.mode])).toEqual([
      ['captions', 'en', 'English', 'disabled'],
      ['captions', 'en', 'English (phone)', 'disabled'],
    ]);
  });

  it('labels the tracks with the language name in the language itself', () => {
    const tracks = addFallbackTracks(makePlayer(), 'nl', { horizontal: VTT, vertical: VTT });
    expect(tracks.map((t) => t.track.label)).toEqual(['Nederlands', 'Nederlands (phone)']);
  });

  it('uses the profile description, or else the id, when the profiles are not exactly horizontal + vertical', () => {
    const tracks = addFallbackTracks(makePlayer(), 'en', { horizontal: VTT, square: VTT }, { square: 'Square video' });
    expect(tracks.map((t) => t.track.label)).toEqual(['horizontal', 'Square video']);
  });

  it('shows only the active profile track when asked to', () => {
    const tracks = addFallbackTracks(makePlayer(), 'en', { horizontal: VTT, vertical: VTT });
    syncFallbackTracks(tracks, 'vertical', true);
    expect(tracks.map((t) => t.track.mode)).toEqual(['disabled', 'showing']);
    syncFallbackTracks(tracks, 'vertical', false);
    expect(tracks.map((t) => t.track.mode)).toEqual(['disabled', 'disabled']);
  });

  it('detects iOS native fullscreen from the class video.js sets', () => {
    const p = makePlayer();
    expect(isNativeIOSFullscreen(p)).toBe(false);
    p.isFullscreen(true);
    expect(isNativeIOSFullscreen(p)).toBe(false); // regular fullscreen: the overlay still works
    p.addClass('vjs-ios-native-fs');
    expect(isNativeIOSFullscreen(p)).toBe(true);
  });

  it('keeps the tracks when the source changes', async () => {
    const p = makePlayer();
    const wait = () => new Promise((resolve) => setTimeout(resolve, 50)); // video.js applies sources asynchronously
    p.src({ src: 'a.mp4', type: 'video/mp4' });
    await wait();
    addFallbackTracks(p, 'en', { horizontal: VTT, vertical: VTT });
    expect(p.remoteTextTracks()).toHaveLength(2);
    p.src({ src: 'b.mp4', type: 'video/mp4' });
    await wait();
    expect(p.remoteTextTracks()).toHaveLength(2);
  });

  it('removes the tracks on request', () => {
    const p = makePlayer();
    const tracks = addFallbackTracks(p, 'en', { horizontal: VTT, vertical: VTT });
    removeFallbackTracks(p, tracks);
    expect(p.remoteTextTracks()).toHaveLength(0);
  });

  it('does not touch a disposed player when removing', () => {
    const p = makePlayer();
    const tracks = addFallbackTracks(p, 'en', { horizontal: VTT });
    p.dispose();
    expect(() => removeFallbackTracks(p, tracks)).not.toThrow();
  });

  it('skips tracks when the tech is not ready and addRemoteTextTrack returns nothing', () => {
    const p = makePlayer();
    p.addRemoteTextTrack = (() => undefined) as unknown as typeof p.addRemoteTextTrack;
    expect(addFallbackTracks(p, 'en', { horizontal: VTT })).toEqual([]);
  });
});

describe('fallbackLabel', () => {
  const both = ['horizontal', 'vertical'];

  it('names the language, with "(phone)" for the vertical profile', () => {
    expect(fallbackLabel('en', 'horizontal', both)).toBe('English');
    expect(fallbackLabel('en', 'vertical', both)).toBe('English (phone)');
    expect(fallbackLabel('nl', 'horizontal', both)).toBe('Nederlands');
    expect(fallbackLabel('fr-CA', 'vertical', both)).toMatch(/^fran\u00e7ais .*\(phone\)$/);
  });

  it('does not depend on the order of the profiles', () => {
    expect(fallbackLabel('en', 'vertical', ['vertical', 'horizontal'])).toBe('English (phone)');
  });

  it('falls back to the description, then the id, for any other set of profiles', () => {
    expect(fallbackLabel('en', 'horizontal', ['horizontal'])).toBe('horizontal');
    expect(fallbackLabel('en', 'horizontal', ['horizontal'], 'Wide')).toBe('Wide');
    expect(fallbackLabel('en', 'vertical', [...both, 'square'])).toBe('vertical');
    expect(fallbackLabel('en', 'square', [...both, 'square'], 'Square')).toBe('Square');
  });

  it('says "Captions" when the language name is unavailable', () => {
    vi.stubGlobal('Intl', { ...Intl, DisplayNames: undefined });
    expect(fallbackLabel('en', 'horizontal', both)).toBe('Captions');
    expect(fallbackLabel('en', 'vertical', both)).toBe('Captions (phone)');
    vi.unstubAllGlobals();
  });

  it('says "Captions", not "Unknown language", when the document language is undetermined or empty', () => {
    for (const lang of ['und', 'UND', 'und-Latn', '', '  ']) {
      expect(fallbackLabel(lang, 'horizontal', both)).toBe('Captions');
      expect(fallbackLabel(lang, 'vertical', both)).toBe('Captions (phone)');
    }
  });

  it('survives a language tag Intl rejects', () => {
    expect(fallbackLabel('not a language!', 'horizontal', both)).toBe('Captions');
    expect(fallbackLabel('', 'vertical', both)).toBe('Captions (phone)');
  });
});

describe('usesNativeTextTracks', () => {
  // jsdom is neither iOS nor Safari, so video.js emulates text tracks there.
  it('is false when the tech emulates text tracks and the browser is not iOS', () => {
    expect(usesNativeTextTracks(makePlayer())).toBe(false);
  });

  it('is true when the tech uses native text tracks', () => {
    const p = makePlayer();
    vi.spyOn(p, 'tech').mockReturnValue({ featuresNativeTextTracks: true } as never);
    expect(usesNativeTextTracks(p)).toBe(true);
  });

  it('is false while there is no tech yet', () => {
    const p = makePlayer();
    vi.spyOn(p, 'tech').mockReturnValue(undefined as never);
    expect(usesNativeTextTracks(p)).toBe(false);
  });
});
