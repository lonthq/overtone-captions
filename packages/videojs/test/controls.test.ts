// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { captionText, createTestPlayer, type TestPlayer } from './player-helpers';
import { loadFixture } from './helpers';

// Pretend native text tracks (as in Safari) so the controller adds its fallback tracks in jsdom too.
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
  vi.useRealTimers();
});

function controlBarNames(): string[] {
  return t.player.getChild('ControlBar')!.children().map((child) => child.name());
}

function button(): HTMLButtonElement {
  return t.player.el().querySelector<HTMLButtonElement>('.ot-captions-button')!;
}

function pressKey(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('captions button', () => {
  it('replaces the default subtitles/captions button at the same position', () => {
    const before = controlBarNames();
    t.overtone({ data: loadFixture() });
    const controlBar = t.player.getChild('ControlBar')!;
    expect(controlBar.getChild('OvertoneCaptionsButton')!.el()).toBe(button());
    expect(controlBarNames().indexOf('OvertoneCaptionsButton')).toBe(before.indexOf('SubsCapsButton'));
    for (const name of ['SubsCapsButton', 'CaptionsButton', 'SubtitlesButton']) {
      expect(controlBar.getChild(name)).toBeFalsy();
    }
  });

  it('keeps its place in the control bar when player.overtone() is called again', async () => {
    const before = controlBarNames();
    t.overtone({ data: loadFixture() });
    await t.overtone({ data: loadFixture() }).ready;
    expect(controlBarNames().filter((name) => name === 'OvertoneCaptionsButton')).toHaveLength(1);
    expect(controlBarNames().indexOf('OvertoneCaptionsButton')).toBe(before.indexOf('SubsCapsButton'));
  });

  it('gives the native captions button back at its place when the document fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    t.player.addRemoteTextTrack({ kind: 'captions', src: 'data:text/vtt,WEBVTT', srclang: 'en', label: 'English' }, false);
    const before = controlBarNames();
    const ctrl = t.overtone({ src: '/missing.json' });
    expect(t.player.getChild('ControlBar')!.getChild('SubsCapsButton')).toBeFalsy();
    await ctrl.ready;
    vi.unstubAllGlobals();
    expect(ctrl.error).toBeDefined();
    const native = t.player.getChild('ControlBar')!.getChild('SubsCapsButton');
    expect(native).toBeTruthy();
    expect(controlBarNames().indexOf('SubsCapsButton')).toBe(before.indexOf('SubsCapsButton'));
    expect(native!.hasClass('vjs-hidden')).toBe(false); // the page's <track> captions can be turned on
    expect(button().classList.contains('vjs-hidden')).toBe(true);
  });

  it('gives the native captions button back when a replacing player.overtone() call fails', async () => {
    await t.overtone({ data: loadFixture() }).ready;
    const failed = t.overtone({ data: { format: 'nope' } as never });
    await failed.ready;
    expect(failed.error).toBeDefined();
    expect(controlBarNames().filter((name) => name === 'SubsCapsButton')).toHaveLength(1);
    // a later successful call replaces it again, at the same place
    const before = controlBarNames().indexOf('SubsCapsButton');
    await t.overtone({ data: loadFixture() }).ready;
    expect(t.player.getChild('ControlBar')!.getChild('SubsCapsButton')).toBeFalsy();
    expect(controlBarNames().indexOf('OvertoneCaptionsButton')).toBe(before);
  });

  it('keeps the default captions menu away when fallback text tracks are added', async () => {
    const ctrl = t.overtone({ data: loadFixture(), fallbackTracks: { horizontal: 'data:text/vtt,WEBVTT' } });
    await ctrl.ready;
    expect(t.player.textTracks()).toHaveLength(1);
    expect(t.player.el().querySelectorAll('.vjs-subs-caps-button')).toHaveLength(0);
  });

  it('cycles off → styled → plain → off with single clicks', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.seek(1.4);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      button().click();
      seen.push(`${ctrl.getMode()}|${button().getAttribute('aria-pressed')}|${button().getAttribute('aria-label')}`);
    }
    expect(seen).toEqual(['plain|true|Captions: plain', 'off|false|Captions: off', 'styled|true|Captions: styled']);
  });

  it('switches the layer classes and empties the layer when off', async () => {
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    t.seek(1.4);
    ctrl.setMode('plain');
    expect(ctrl.layer.classList.contains('ot-mode-plain')).toBe(true);
    expect(ctrl.layer.classList.contains('ot-mode-styled')).toBe(false);
    expect(captionText(ctrl.layer)).toContain('Every year');
    ctrl.setMode('off');
    expect(ctrl.layer.classList.contains('ot-mode-off')).toBe(true);
    expect(captionText(ctrl.layer)).toBe('');
    ctrl.setMode('styled');
    expect(captionText(ctrl.layer)).toContain('Every year');
  });

  it('shows a short toast with the new state', async () => {
    vi.useFakeTimers();
    const ctrl = t.overtone({ data: loadFixture() });
    button().click();
    expect(ctrl.toast.el.textContent).toBe('Captions: plain');
    expect(ctrl.toast.el.classList.contains('ot-toast-visible')).toBe(true);
    vi.advanceTimersByTime(1600);
    expect(ctrl.toast.el.classList.contains('ot-toast-visible')).toBe(false);
  });
});

describe('keyboard', () => {
  it('cycles on "c" anywhere inside the player, including on control-bar buttons', () => {
    const ctrl = t.overtone({ data: loadFixture() });
    const event = pressKey(t.player.el(), 'c');
    expect(ctrl.getMode()).toBe('plain');
    expect(event.defaultPrevented).toBe(true);
    pressKey(button(), 'C'); // video.js buttons stop keydown propagation; we listen in the capture phase
    expect(ctrl.getMode()).toBe('off');
  });

  it('ignores "c" with modifier keys and other keys', () => {
    const ctrl = t.overtone({ data: loadFixture() });
    pressKey(t.player.el(), 'c', { metaKey: true });
    pressKey(t.player.el(), 'c', { ctrlKey: true });
    pressKey(t.player.el(), 'x');
    expect(ctrl.getMode()).toBe('styled');
  });
});

describe('remembered mode', () => {
  it('starts in defaultMode when nothing is stored', () => {
    expect(t.overtone({ data: loadFixture(), defaultMode: 'off' }).getMode()).toBe('off');
  });

  it('stores the choice and uses it next time', () => {
    t.overtone({ data: loadFixture() }).setMode('plain');
    expect(localStorage.getItem('overtone-caption-mode')).toBe('plain');
    const other = createTestPlayer();
    expect(other.overtone({ data: loadFixture() }).getMode()).toBe('plain');
    other.player.dispose();
  });

  it('uses the storageKey option', () => {
    t.overtone({ data: loadFixture(), storageKey: 'my-key' }).setMode('off');
    expect(localStorage.getItem('my-key')).toBe('off');
  });
});

describe('overtone:modechange event', () => {
  it('fires once per real change, with the new mode, for setMode, the button and the c key', () => {
    const ctrl = t.overtone({ data: loadFixture() });
    const seen: unknown[] = [];
    t.player.on('overtone:modechange', (event: { mode?: string }) => seen.push(event.mode));
    ctrl.setMode('plain');
    expect(seen).toEqual(['plain']);
    button().click();
    expect(seen).toEqual(['plain', 'off']);
    pressKey(t.player.el(), 'c');
    expect(seen).toEqual(['plain', 'off', 'styled']);
  });

  it('does not fire when the mode is set to the one it already has', () => {
    const ctrl = t.overtone({ data: loadFixture() });
    const listener = vi.fn();
    t.player.on('overtone:modechange', listener);
    ctrl.setMode('styled');
    expect(listener).not.toHaveBeenCalled();
  });

  it('lets two players keep each other in sync without looping', () => {
    const other = createTestPlayer();
    const a = t.overtone({ data: loadFixture() });
    const b = other.overtone({ data: loadFixture() });
    t.player.on('overtone:modechange', (event: { mode: 'off' | 'styled' | 'plain' }) => b.setMode(event.mode));
    other.player.on('overtone:modechange', (event: { mode: 'off' | 'styled' | 'plain' }) => a.setMode(event.mode));
    a.setMode('plain');
    expect([a.getMode(), b.getMode()]).toEqual(['plain', 'plain']);
    b.cycle();
    expect([a.getMode(), b.getMode()]).toEqual(['off', 'off']);
    other.player.dispose();
  });
});

describe('after a failed load', () => {
  it('offers no captions control: the c key does nothing', async () => {
    const ctrl = t.overtone({ data: { format: 'nope' } as never });
    await ctrl.ready;
    expect(ctrl.error).toBeDefined();
    const changes: unknown[] = [];
    t.player.on('overtone:modechange', (event: unknown) => changes.push(event));
    const key = pressKey(t.player.el(), 'c');
    expect(key.defaultPrevented).toBe(false);
    expect(ctrl.getMode()).toBe('styled');
    expect(changes).toEqual([]);
    expect(localStorage.getItem('overtone-caption-mode')).toBeNull();
  });
});

describe("the page's own caption tracks", () => {
  function pageTrack(mode: TextTrackMode = 'showing'): TextTrack {
    const el = t.player.addRemoteTextTrack({ kind: 'captions', src: 'data:text/vtt,WEBVTT', srclang: 'en', label: 'English', mode }, false);
    return (el as unknown as { track: TextTrack }).track;
  }

  it.each(['styled', 'plain', 'off'] as const)('turns a showing track off after loading, in %s mode', async (mode) => {
    const track = pageTrack();
    const subtitles = t.player.addRemoteTextTrack({ kind: 'subtitles', src: 'data:text/vtt,WEBVTT', srclang: 'nl', mode: 'showing' }, false);
    const chapters = t.player.addRemoteTextTrack({ kind: 'chapters', src: 'data:text/vtt,WEBVTT', mode: 'showing' }, false);
    const ctrl = t.overtone({ data: loadFixture(), defaultMode: mode });
    await ctrl.ready;
    expect(track.mode).toBe('disabled');
    expect((subtitles as unknown as { track: TextTrack }).track.mode).toBe('disabled');
    expect((chapters as unknown as { track: TextTrack }).track.mode).not.toBe('disabled'); // not captions
    ctrl.setMode('styled');
    expect(track.mode).toBe('disabled');
  });

  it('keeps a <track default> off when video.js turns it on again at loadedmetadata', async () => {
    const el = t.player.addRemoteTextTrack({ kind: 'captions', src: 'data:text/vtt,WEBVTT', srclang: 'en', default: true }, false);
    const track = (el as unknown as { track: TextTrack }).track;
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    await new Promise((resolve) => t.player.ready(() => resolve(undefined)));
    t.player.trigger('loadedmetadata'); // video.js preselects the default track here
    expect(track.mode).toBe('disabled');
    ctrl.dispose();
    expect(track.mode).toBe('showing');
  });

  it('keeps a track off that the page turns on later', async () => {
    const track = pageTrack('disabled');
    await t.overtone({ data: loadFixture() }).ready;
    track.mode = 'showing';
    await new Promise((resolve) => setTimeout(resolve, 10)); // video.js queues the list's `change` event
    expect(track.mode).toBe('disabled');
  });

  it('leaves its own fallback tracks and hidden tracks alone', async () => {
    const hidden = pageTrack('hidden');
    await t.overtone({ data: loadFixture(), fallbackTracks: { horizontal: 'data:text/vtt,WEBVTT' } }).ready;
    expect(hidden.mode).toBe('hidden');
    expect(t.player.textTracks()).toHaveLength(2);
  });

  it('gives the tracks their mode back after a manual dispose', async () => {
    const track = pageTrack();
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    ctrl.dispose();
    expect(track.mode).toBe('showing');
  });

  it('turns them off again when player.overtone() replaces the controller', async () => {
    const track = pageTrack();
    await t.overtone({ data: loadFixture() }).ready;
    await t.overtone({ data: loadFixture() }).ready;
    expect(track.mode).toBe('disabled');
  });

  it('leaves a showing track on when the document fails to load', async () => {
    const track = pageTrack();
    const ctrl = t.overtone({ data: { format: 'nope' } as never });
    await ctrl.ready;
    expect(ctrl.error).toBeDefined();
    expect(track.mode).toBe('showing');
  });
});

describe('manual dispose', () => {
  it("gives video.js's captions button back at its original place", async () => {
    const before = controlBarNames();
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    ctrl.dispose();
    expect(controlBarNames()).not.toContain('OvertoneCaptionsButton');
    expect(controlBarNames().indexOf('SubsCapsButton')).toBe(before.indexOf('SubsCapsButton'));
    expect(controlBarNames()).toEqual(before);
  });

  it('still lets a later player.overtone() call replace the button at the same place', async () => {
    const before = controlBarNames();
    const ctrl = t.overtone({ data: loadFixture() });
    await ctrl.ready;
    ctrl.dispose();
    await t.overtone({ data: loadFixture() }).ready;
    expect(t.player.getChild('ControlBar')!.getChild('SubsCapsButton')).toBeFalsy();
    expect(controlBarNames().indexOf('OvertoneCaptionsButton')).toBe(before.indexOf('SubsCapsButton'));
  });

  it('adds nothing back while the player itself is disposed', async () => {
    const other = createTestPlayer();
    const add = vi.spyOn(other.player.getChild('ControlBar')!, 'addChild');
    const track = (other.player.addRemoteTextTrack({ kind: 'captions', src: 'data:text/vtt,WEBVTT', mode: 'showing' }, false) as unknown as { track: TextTrack }).track;
    const ctrl = other.overtone({ data: loadFixture() });
    await ctrl.ready;
    add.mockClear();
    expect(() => other.player.dispose()).not.toThrow();
    expect(add).not.toHaveBeenCalled();
    expect(track.mode).toBe('disabled');
    expect(() => ctrl.dispose()).not.toThrow();
  });
});
