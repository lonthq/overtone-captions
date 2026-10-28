import videojs from 'video.js';
import type { ButtonClass, Player } from '../video-types.js';
import { modeLabel } from '../core/state.js';
import type { CaptionMode } from '../types.js';

// video.js components are looked up at runtime; the cast restores the real Button type.
const Button = videojs.getComponent('Button') as unknown as ButtonClass;

/** Set by the controller. Without them the button shows "styled" and a click does nothing. */
export interface CaptionsButtonOptions {
  mode?: CaptionMode;
  onCycle?: () => void;
}

/** Control-bar button that replaces video.js's captions menu; a click cycles off → styled → plain via `onCycle`. */
export class OvertoneCaptionsButton extends Button {
  private mode: CaptionMode;

  constructor(player: Player, options: CaptionsButtonOptions = {}) {
    // `name` makes getChild('OvertoneCaptionsButton') work; video.js keeps the options as this.options_.
    super(player, { name: 'OvertoneCaptionsButton', ...options } as object);
    this.mode = options.mode ?? 'styled';
    // No-op unless video.js SVG icons are enabled.
    this.setIcon('captions');
    this.update(this.mode);
  }

  buildCSSClass(): string {
    // vjs-captions-button: video.js's standard CC icon.
    return `ot-captions-button vjs-captions-button ${super.buildCSSClass()}`;
  }

  handleClick(): void {
    (this.options_ as CaptionsButtonOptions).onCycle?.();
  }

  handleLanguagechange(): void {
    super.handleLanguagechange();
    this.el().setAttribute('aria-label', this.localize(modeLabel(this.mode)));
  }

  update(mode: CaptionMode): void {
    this.mode = mode;
    const label = modeLabel(mode);
    this.controlText(label);
    const el = this.el();
    el.setAttribute('aria-label', this.localize(label));
    el.setAttribute('aria-pressed', String(mode !== 'off'));
    el.classList.remove('ot-mode-off', 'ot-mode-styled', 'ot-mode-plain');
    el.classList.add(`ot-mode-${mode}`);
  }
}
