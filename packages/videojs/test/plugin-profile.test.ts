// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.unstubAllGlobals();
});

describe('profile selection', () => {
  it('switches live between horizontal and vertical when the player changes shape', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.seek(1.4);
    expect(ctrl.getProfileId()).toBe('horizontal');
    t.resize(360, 640);
    expect(ctrl.getProfileId()).toBe('vertical');
    expect(ctrl.layer.classList.contains('ot-profile-vertical')).toBe(true);
    expect(ctrl.layer.classList.contains('ot-profile-horizontal')).toBe(false);
    expect(captionText(ctrl.layer)).toBe('Every year, / one in five drivers');
    t.resize(640, 360);
    expect(ctrl.getProfileId()).toBe('horizontal');
  });

  it('reacts to ResizeObserver callbacks', async () => {
    let callback: () => void = () => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callback = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    vi.spyOn(t.player.el(), 'getBoundingClientRect').mockReturnValue({ width: 360, height: 640 } as DOMRect);
    callback();
    expect(ctrl.getProfileId()).toBe('vertical');
  });

  it('keeps an explicit profile regardless of shape', async () => {
    const ctrl = t.overtone({ data: loadFixture(), profile: 'vertical' });
    await ctrl.ready;
    t.resize(640, 360);
    expect(ctrl.getProfileId()).toBe('vertical');
  });

  it('falls back to the first profile when the wanted one is missing', async () => {
    const doc = loadFixture();
    doc.profiles = doc.profiles.filter((p) => p.id === 'vertical');
    const ctrl = t.overtone({ data: doc });
    await ctrl.ready;
    expect(ctrl.getProfileId()).toBe('vertical');
  });

  it('places the layer inside a picture box over the letterboxed video', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.resize(640, 360);
    t.setVideo(1080, 1080);
    const picture = ctrl.layer.parentElement!;
    expect(picture.classList.contains('ot-picture')).toBe(true);
    expect([picture.style.left, picture.style.top, picture.style.width, picture.style.height]).toEqual(['140px', '0px', '360px', '360px']);
  });

  it('anchors the picture box at its left and top, so a right-to-left page does not move it to the right edge', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.resize(640, 360);
    t.setVideo(1080, 1080);
    const picture = ctrl.layer.parentElement!;
    expect([picture.style.right, picture.style.bottom]).toEqual(['auto', 'auto']);
  });

  it('chooses by the video shape, not the player shape', async () => {
    const doc = loadFixture();
    doc.profiles.push({ ...doc.profiles[0], id: '1x1', aspect: '1:1', rules: { ...doc.profiles[0].rules, maxCharsPerLine: 32 } });
    const ctrl = t.overtone({ data: doc });
    await ctrl.ready;
    t.resize(640, 360);
    expect(ctrl.getProfileId()).toBe('horizontal');
    t.setVideo(1080, 1080);
    expect(ctrl.getProfileId()).toBe('1x1');
    expect(ctrl.layer.style.getPropertyValue('--ot-chars')).toBe('32');
  });

  it('follows the player box when the video is cropped (object-fit: cover)', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.resize(360, 640);
    t.setVideo(1920, 1080, 'cover');
    expect(ctrl.getProfileId()).toBe('vertical');
    expect(ctrl.layer.classList.contains('ot-tall')).toBe(true);
  });

  it('re-chooses when the intrinsic video size changes mid-stream (resize event)', async () => {
    const doc = loadFixture();
    doc.profiles.push({ ...doc.profiles[0], id: '1x1', aspect: '1:1', rules: { ...doc.profiles[0].rules, maxCharsPerLine: 32 } });
    const ctrl = t.overtone({ data: doc });
    await ctrl.ready;
    t.resize(640, 360);
    t.setVideo(1920, 1080);
    expect(ctrl.getProfileId()).toBe('horizontal');
    const video = t.player.el().querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 1080 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 1080 });
    t.player.trigger('resize');
    expect(ctrl.getProfileId()).toBe('1x1');
  });
});
