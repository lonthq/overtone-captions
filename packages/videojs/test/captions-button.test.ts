// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player.js';
import { OvertoneCaptionsButton } from '../src/components/CaptionsButton';
import type { CaptionMode } from '../src/types';
import { createPlayer } from './player-helpers';

let player: Player | undefined;

afterEach(() => {
  player?.dispose();
  player = undefined;
});

function makeButton(mode: CaptionMode) {
  const onCycle = vi.fn();
  const current = createPlayer();
  player = current;
  return { button: new OvertoneCaptionsButton(current, { mode, onCycle }), onCycle };
}

describe('OvertoneCaptionsButton', () => {
  it('renders a button with the CC icon classes', () => {
    const el = makeButton('styled').button.el();
    expect(el.tagName).toBe('BUTTON');
    expect(el.classList.contains('ot-captions-button')).toBe(true);
    expect(el.classList.contains('vjs-captions-button')).toBe(true);
    expect(el.querySelector('.vjs-icon-placeholder')).not.toBeNull();
  });

  it('reflects the initial mode in aria-label, aria-pressed, control text and a mode class', () => {
    const { button } = makeButton('styled');
    expect(button.el().getAttribute('aria-label')).toBe('Captions: styled');
    expect(button.el().getAttribute('aria-pressed')).toBe('true');
    expect(button.el().classList.contains('ot-mode-styled')).toBe(true);
    expect(button.controlText()).toBe('Captions: styled');
  });

  it('calls onCycle once per click', () => {
    const { button, onCycle } = makeButton('off');
    (button.el() as HTMLButtonElement).click();
    expect(onCycle).toHaveBeenCalledTimes(1);
  });

  it('updates its state when told the new mode', () => {
    const { button } = makeButton('styled');
    button.update('off');
    expect(button.el().getAttribute('aria-label')).toBe('Captions: off');
    expect(button.el().getAttribute('aria-pressed')).toBe('false');
    expect(button.el().classList.contains('ot-mode-styled')).toBe(false);
    expect(button.el().classList.contains('ot-mode-off')).toBe(true);
    button.update('plain');
    expect(button.el().getAttribute('aria-pressed')).toBe('true');
  });

  it('is named so the control bar can find it', () => {
    expect(makeButton('off').button.name()).toBe('OvertoneCaptionsButton');
  });

  it('localizes the aria-label and refreshes it on languagechange', () => {
    videojs.addLanguage('nl', { 'Captions: styled': 'Ondertiteling: opgemaakt' });
    const { button } = makeButton('styled');
    const current = player as Player;
    try {
      current.language('nl');
      button.update('styled');
      expect(button.el().getAttribute('aria-label')).toBe('Ondertiteling: opgemaakt');
      current.language('en');
      expect(button.el().getAttribute('aria-label')).toBe('Captions: styled');
      current.language('nl');
      expect(button.el().getAttribute('aria-label')).toBe('Ondertiteling: opgemaakt');
    } finally {
      current.language('en');
    }
  });

  it('shows an SVG icon when the player uses SVG icons', () => {
    const video = document.createElement('video');
    document.body.append(video);
    const svgPlayer = videojs(video, { controls: true, experimentalSvgIcons: true });
    player = svgPlayer;
    const button = new OvertoneCaptionsButton(svgPlayer, { mode: 'styled', onCycle: vi.fn() });
    expect(button.el().querySelector('svg use')).not.toBeNull();
  });
});

describe('OvertoneCaptionsButton without options', () => {
  it('shows "styled" and does nothing on click instead of throwing', () => {
    const player = createPlayer();
    const button = new OvertoneCaptionsButton(player);
    expect(button.el().classList.contains('ot-mode-styled')).toBe(true);
    expect(() => button.handleClick()).not.toThrow();
    player.dispose();
  });

  it('is not registered as a component: the controller adds its own, wired to the overlay', () => {
    expect(videojs.getComponent('OvertoneCaptionsButton')).toBeFalsy();
  });
});
