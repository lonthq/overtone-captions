// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import videojs from 'video.js';
import '../src/index';
import { captionText, createTestPlayer, type TestPlayer } from './player-helpers';
import { loadFixture } from './helpers';

let t: TestPlayer;

beforeEach(() => {
  localStorage.clear();
  t = createTestPlayer();
});

afterEach(() => {
  t.player.dispose();
  vi.restoreAllMocks();
});

describe('player.overtone()', () => {
  it('is registered as the video.js plugin "overtone"', () => {
    expect(typeof videojs.getPlugin('overtone')).toBe('function');
  });

  it('adds the overlay layer with theme, mode and profile classes', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    expect(t.player.el().classList.contains('ot-host')).toBe(true);
    expect(t.player.el().querySelector('.ot-layer')).toBe(ctrl.layer);
    expect([...ctrl.layer.classList].sort()).toEqual(
      ['ot-layer', 'ot-mode-styled', 'ot-profile-horizontal', 'ot-theme-clean'].sort(),
    );
  });

  it('renders the cue for the current time and marks the spoken word', async () => {
    const ctrl = t.overtone({ data: loadFixture(), speakers: 'change' });
    await ctrl.ready;
    t.seek(1.4);
    expect(captionText(ctrl.layer)).toBe('Every year, one in five drivers / has some kind of car damage.');
    expect(ctrl.layer.querySelector('.ot-active')?.textContent).toBe('one');
    t.seek(10.5);
    expect(captionText(ctrl.layer)).toBe('And the best part? / You can claim directly in the app.');
    expect(ctrl.layer.querySelector('.ot-speaker')?.textContent).toBe('Tom');
  });

  it('hides speaker names by default', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    for (const time of [1.4, 5, 10.5, 15]) {
      t.seek(time);
      expect(captionText(ctrl.layer)).not.toBe('');
      expect(ctrl.layer.querySelector('.ot-speaker')).toBeNull();
    }
  });

  it('shows nothing between cues and outside the profile window', async () => {
    const doc = loadFixture();
    doc.profiles[0].window = { start: 4.5, end: 18 };
    const ctrl = t.overtone({ data: doc });
    await ctrl.ready;
    t.seek(4.4); // between cue 0 and cue 1
    expect(captionText(ctrl.layer)).toBe('');
    t.seek(2); // cue 0 exists, but before the window
    expect(captionText(ctrl.layer)).toBe('');
    t.seek(5);
    expect(captionText(ctrl.layer)).toContain('With DriveCover');
  });

  it('holds the previous cue through a tiny gap instead of blinking', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.seek(8.04); // cue 1 ends at 8.032, cue 2 starts at 8.057
    expect(captionText(ctrl.layer)).toContain('With DriveCover');
    t.seek(8.06);
    expect(captionText(ctrl.layer)).toContain('$12');
  });

  it('ignores options set to undefined and falls back for invalid ones', async () => {
    const ctrl = t.overtone({
      data: loadFixture(),
      theme: undefined,
      fallbackTracks: undefined,
      defaultMode: undefined,
      profile: undefined,
      speakers: undefined,
      storageKey: undefined,
    });
    await ctrl.ready;
    expect(ctrl.error).toBeUndefined();
    expect(ctrl.getMode()).toBe('styled');
    expect([...ctrl.layer.classList].sort()).toEqual(
      ['ot-layer', 'ot-mode-styled', 'ot-profile-horizontal', 'ot-theme-clean'].sort(),
    );
    t.seek(10.5);
    expect(ctrl.layer.querySelector('.ot-speaker')).toBeNull(); // speakers default: 'never'
    ctrl.setMode('plain');
    expect(localStorage.getItem('overtone-caption-mode')).toBe('plain');
  });

  it('accepts null options like no options', async () => {
    const ctrl = t.overtone(null as never);
    await ctrl.ready;
    expect(ctrl.getMode()).toBe('styled');
    expect(ctrl.error?.message).toContain('pass `src`');
    expect(ctrl.layer.classList.contains('ot-theme-clean')).toBe(true);
  });

  it('uses the default theme for an empty theme and styled for an invalid defaultMode', async () => {
    const ctrl = t.overtone({ data: loadFixture(), theme: '', defaultMode: 'loud' as never });
    await ctrl.ready;
    expect(ctrl.getMode()).toBe('styled');
    expect(ctrl.layer.classList.contains('ot-theme-clean')).toBe(true);
  });

  it('applies the theme option and setTheme()', async () => {
    const ctrl = t.overtone({ data: loadFixture(), theme: 'social' });
    expect(ctrl.layer.classList.contains('ot-theme-social')).toBe(true);
    ctrl.setTheme('lumora');
    expect(ctrl.layer.classList.contains('ot-theme-social')).toBe(false);
    expect(ctrl.layer.classList.contains('ot-theme-lumora')).toBe(true);
  });

  it('reports a load error without throwing and renders nothing', async () => {
    const ctrl = t.overtone({ data: { format: 'nope' } as never });
    await ctrl.ready;
    expect(ctrl.error?.message).toContain('Invalid Overtone document');
    expect(t.player.log.error).toHaveBeenCalled();
    t.seek(1.4);
    expect(captionText(ctrl.layer)).toBe('');
  });

  it('loads a document from src with fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(loadFixture())));
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = t.overtone({ src: '/captions/sample.overtone.json' });
    await ctrl.ready;
    expect(fetchMock).toHaveBeenCalledWith('/captions/sample.overtone.json');
    t.seek(1.4);
    expect(captionText(ctrl.layer)).toContain('Every year');
    vi.unstubAllGlobals();
  });

  it('reports HTTP errors when loading src', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    const ctrl = t.overtone({ src: '/missing.json' });
    await ctrl.ready;
    expect(ctrl.error?.message).toBe('HTTP 404 while loading /missing.json');
    vi.unstubAllGlobals();
  });

  it('replaces an earlier overlay when called twice', async () => {
    t.overtone({ data: loadFixture() });
    const second = t.overtone({ data: loadFixture() });
    await second.ready;
    expect(t.player.el().querySelectorAll('.ot-layer')).toHaveLength(1);
    expect(t.player.el().querySelectorAll('.ot-captions-button')).toHaveLength(1);
  });

  it('runs an animation-frame loop only while playing', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const caf = vi.spyOn(window, 'cancelAnimationFrame');
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.player.trigger('play');
    expect(raf).toHaveBeenCalled();
    t.player.trigger('pause');
    expect(caf).toHaveBeenCalled();
  });

  it('starts the animation-frame loop when created while the video plays', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    vi.spyOn(t.player, 'paused').mockReturnValue(false);
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    expect(raf).toHaveBeenCalled();
  });

  it('cleans up when the player is disposed', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    const el = t.player.el();
    t.player.dispose();
    expect(el.querySelector('.ot-layer')).toBeNull();
    expect(el.querySelector('.ot-picture')).toBeNull();
    expect(ctrl.layer.isConnected).toBe(false);
    t = createTestPlayer(); // afterEach disposes a fresh player
  });
});

describe('robustness', () => {
  it('turns themes into safe class names and keeps valid profile ids intact', async () => {
    // Profile ids are restricted to [A-Za-z0-9_-] by the format validator, which the plugin enforces.
    const doc = loadFixture();
    doc.profiles[0].id = 'my_profile-2';
    const ctrl = t.overtone({ data: doc, profile: 'my_profile-2', theme: 'my theme' });
    await expect(ctrl.ready).resolves.toBeUndefined();
    expect(ctrl.error).toBeUndefined();
    expect(ctrl.layer.classList.contains('ot-profile-my_profile-2')).toBe(true);
    expect(ctrl.layer.classList.contains('ot-theme-my-theme')).toBe(true);
    expect(() => ctrl.setTheme('brand <x>')).not.toThrow();
    expect(ctrl.layer.classList.contains('ot-theme-brand--x-')).toBe(true);
    expect(ctrl.layer.classList.contains('ot-theme-my-theme')).toBe(false);
  });

  it('reports an error thrown while applying a loaded document', async () => {
    vi.spyOn(t.player.el(), 'getBoundingClientRect').mockImplementation(() => {
      throw new Error('boom');
    });
    const ctrl = t.overtone({ data: loadFixture() });
    await expect(ctrl.ready).resolves.toBeUndefined();
    expect(ctrl.error?.message).toBe('boom');
    expect(t.player.log.error).toHaveBeenCalledWith('overtone: boom');
  });

  it('marks the layer and hides the captions button when loading fails', async () => {
    const ctrl = t.overtone({ data: { format: 'nope' } as never });
    await ctrl.ready;
    expect(ctrl.layer.classList.contains('ot-error')).toBe(true);
    expect(t.player.el().querySelector('.ot-captions-button')!.classList.contains('vjs-hidden')).toBe(true);
  });

  it('can be disposed twice, and after the player', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    ctrl.dispose();
    expect(() => ctrl.dispose()).not.toThrow();
    const other = createTestPlayer();
    const second = other.overtone({ data: loadFixture() });
    await second.ready;
    other.player.dispose();
    expect(() => second.dispose()).not.toThrow();
  });

  it('removes the ot-host class on dispose', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    ctrl.dispose();
    expect(t.player.hasClass('ot-host')).toBe(false);
  });

  it('stops the animation-frame loop once the media is paused without a pause event', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    const paused = vi.spyOn(t.player, 'paused').mockReturnValue(false);
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.player.trigger('play');
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(frames).toHaveLength(2); // still playing: next frame requested
    paused.mockReturnValue(true); // e.g. a source change while playing fires no pause
    frames[1](0);
    expect(frames).toHaveLength(2);
  });
});
