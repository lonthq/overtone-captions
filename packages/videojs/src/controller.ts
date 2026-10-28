import { assertValid, type OvertoneDocument, type Profile } from 'overtone-format';
import type { Player } from './video-types.js';
import { OvertoneCaptionsButton } from './components/CaptionsButton.js';
import { cueIndexAt } from './core/cue-at.js';
import { isNativeIOSFullscreen } from './core/fallback.js';
import { FallbackSync } from './core/fallback-sync.js';
import { isCaptionsKey } from './core/keyboard.js';
import { applyProfileToLayer, classToken } from './core/layer.js';
import { pictureRect } from './core/picture.js';
import { chooseProfile } from './core/profile.js';
import { renderCue, updateActiveWords } from './core/render.js';
import { isCaptionMode, modeLabel, nextMode, readStoredMode, storeMode } from './core/state.js';
import { Toast } from './core/toast.js';
import type { CaptionMode, OvertoneOptions, SpeakerDisplay } from './types.js';

interface ResolvedOptions {
  src?: string;
  data?: OvertoneDocument;
  profile: string;
  theme: string;
  speakers: SpeakerDisplay;
  fallbackTracks: Record<string, string>;
  storageKey: string;
  defaultMode: CaptionMode;
}

const DEFAULTS = {
  profile: 'auto',
  theme: 'clean',
  speakers: 'never',
  fallbackTracks: {},
  storageKey: 'overtone-caption-mode',
  defaultMode: 'styled',
} satisfies Omit<ResolvedOptions, 'src' | 'data'>;

const RENDER_EVENTS = ['timeupdate', 'seeked'];
const STOP_EVENTS = ['pause', 'ended'];
const SHAPE_EVENTS = ['playerresize', 'fullscreenchange', 'loadedmetadata', 'resize'];

/** video.js caption controls that the Overtone button replaces. */
const NATIVE_CAPTION_BUTTONS = ['SubsCapsButton', 'CaptionsButton', 'SubtitlesButton'];

/** Where a disposed controller's button sat, so a replacing controller puts its button in the same place. */
const buttonSlots = new WeakMap<Player, number>();

/** Native caption buttons replaced on a player, by this or an earlier controller. A failed load puts them back. */
const replacedButtons = new WeakMap<Player, string[]>();

/** DEFAULTS overridden by the set options; undefined values, an invalid defaultMode and an empty theme keep the default. */
function resolveOptions(options: OvertoneOptions | null | undefined): ResolvedOptions {
  const set = Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined));
  const resolved: ResolvedOptions = { ...DEFAULTS, ...set };
  if (!isCaptionMode(resolved.defaultMode)) resolved.defaultMode = DEFAULTS.defaultMode;
  if (!resolved.theme) resolved.theme = DEFAULTS.theme;
  return resolved;
}

/** One Overtone overlay on one player. Created by `player.overtone(options)`. */
export class OvertoneController {
  readonly layer: HTMLDivElement;
  /** Positioned over the visible video; holds the layer and is the size container for the caption text. */
  readonly picture: HTMLDivElement;
  readonly toast: Toast;
  /** Resolves once the document is loaded and the first cue rendered, or loading failed (see `error`). */
  readonly ready: Promise<void>;
  error: Error | undefined;

  private readonly player: Player;
  private readonly host: HTMLElement;
  private readonly options: ResolvedOptions;
  private readonly button: OvertoneCaptionsButton | undefined;
  private doc: OvertoneDocument | undefined;
  private profile: Profile | undefined;
  private mode: CaptionMode;
  private theme = '';
  private cueIndex = -1;
  private cueEl: HTMLElement | null = null;
  private frame = 0;
  private resizeObserver: ResizeObserver | undefined;
  private readonly fallback: FallbackSync;
  private disposed = false;
  /** Set on the player's `dispose`: nothing needs to be given back to it. */
  private playerDisposing = false;
  /** The page's own caption tracks this controller turned off, with the mode each one had. */
  private silencedTracks: { track: TextTrack; mode: TextTrackMode }[] = [];
  /** The player's text track list, while the page's caption tracks are kept off. */
  private watchedTracks: EventTarget | undefined;

  constructor(player: Player, options: OvertoneOptions = {}) {
    this.player = player;
    this.host = player.el() as HTMLElement;
    this.options = resolveOptions(options);
    this.mode = readStoredMode(this.options.storageKey, this.options.defaultMode);

    player.addClass('ot-host');
    this.layer = document.createElement('div');
    this.layer.className = 'ot-layer';
    this.layer.setAttribute('aria-live', 'off');
    this.picture = document.createElement('div');
    this.picture.className = 'ot-picture';
    this.picture.append(this.layer);
    this.host.insertBefore(this.picture, player.getChild('ControlBar')?.el() ?? null);
    this.toast = new Toast(this.host);
    this.fallback = new FallbackSync(
      player,
      this.options.fallbackTracks,
      () => (this.mode === 'off' ? undefined : this.profile?.id),
      this.onFullscreenChange,
    );
    this.button = this.addButton();
    this.setTheme(this.options.theme);
    this.applyMode();

    player.on(RENDER_EVENTS, this.update);
    player.on('play', this.startLoop);
    player.on(STOP_EVENTS, this.stopLoop);
    // Created while playing (autoplay, a late player.overtone()): no `play` event follows.
    if (!player.paused()) this.startLoop();
    player.on(SHAPE_EVENTS, this.updateProfile);
    player.on('dispose', this.onPlayerDispose);
    // Capture phase: video.js buttons stop keydown propagation, so a bubbling listener would miss them.
    this.host.addEventListener('keydown', this.onKeyDown, true);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateProfile());
      this.resizeObserver.observe(this.host);
    }

    this.ready = this.load()
      .then((doc) => {
        if (this.disposed) return;
        this.doc = doc;
        this.updateProfile();
        this.fallback.add(doc.language, doc.profiles);
        // After video.js's own ready callback, which turns on a `<track default>`.
        player.ready(this.watchNativeTracks, true);
      })
      .catch((error: unknown) => this.fail(error));
  }

  getMode(): CaptionMode {
    return this.mode;
  }

  /** Sets and stores the caption mode, shows the toast and, on a change, fires `overtone:modechange` (`event.mode`). */
  setMode(mode: CaptionMode): void {
    const changed = mode !== this.mode;
    this.mode = mode;
    storeMode(this.options.storageKey, mode);
    this.applyMode();
    this.toast.show(modeLabel(mode));
    if (changed) this.player.trigger({ type: 'overtone:modechange', mode });
  }

  /** off → styled → plain → off (captions button and the `c` key). */
  cycle(): void {
    this.setMode(nextMode(this.mode));
  }

  /** Sets the `ot-theme-<theme>` class; characters not valid in a class name become '-'. */
  setTheme(theme: string): void {
    if (this.theme) this.layer.classList.remove(`ot-theme-${this.theme}`);
    this.theme = classToken(theme);
    this.layer.classList.add(`ot-theme-${this.theme}`);
  }

  getProfileId(): string | undefined {
    return this.profile?.id;
  }

  /** Shows the cue for the player's current time. Runs on timeupdate/seeked and every frame while playing. */
  readonly update = (): void => {
    const profile = this.profile;
    if (!this.doc || !profile || this.mode === 'off') {
      this.show(-1);
      return;
    }
    const time = this.player.currentTime() ?? 0;
    this.show(cueIndexAt(profile, time));
    if (this.cueEl) updateActiveWords(this.cueEl, time);
  };

  /** Places the picture box over the visible video, picks the profile for its shape and re-renders when that changes. */
  readonly updateProfile = (): void => {
    const box = this.host.getBoundingClientRect();
    const video = this.host.querySelector<HTMLVideoElement>('video.vjs-tech');
    const rect = pictureRect(
      { width: box.width, height: box.height },
      video ? { width: video.videoWidth, height: video.videoHeight } : undefined,
      video ? getComputedStyle(video).objectFit : '',
    );
    Object.assign(this.picture.style, {
      position: 'absolute',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      // Undo base.css's `inset: 0`: on a right-to-left page `right` would win over `left`.
      right: 'auto',
      bottom: 'auto',
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    if (!this.doc) return;
    const profile = chooseProfile(this.doc, this.options.profile, rect);
    if (profile === this.profile) return;
    this.profile = profile;
    applyProfileToLayer(this.layer, profile);
    this.show(-1);
    this.update();
    this.fallback.sync();
  };

  /**
   * Removes the overlay, button and listeners; runs when the player is disposed. On a live player it also restores
   * video.js's caption buttons and the page's caption tracks.
   */
  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.player.off(RENDER_EVENTS, this.update);
    this.player.off('play', this.startLoop);
    this.player.off(STOP_EVENTS, this.stopLoop);
    this.player.off(SHAPE_EVENTS, this.updateProfile);
    this.player.off('dispose', this.onPlayerDispose);
    this.fallback.dispose();
    this.host.removeEventListener('keydown', this.onKeyDown, true);
    this.unwatchNativeTracks();
    if (!this.playerDisposing) {
      this.restoreNativeTracks();
      // Before the Overtone button goes, so the native buttons return to its slot.
      this.restoreNativeButtons();
    }
    if (this.button) {
      const controlBar = this.player.getChild('ControlBar');
      const slot = controlBar?.children().indexOf(this.button) ?? -1;
      if (slot >= 0) buttonSlots.set(this.player, slot);
      controlBar?.removeChild(this.button);
      this.button.dispose();
    }
    this.toast.dispose();
    this.picture.remove();
    this.player.removeClass('ot-host');
  };

  /** Logs a failed load without throwing and hands captions back to video.js's own buttons and `<track>`s. */
  private fail(error: unknown): void {
    if (this.disposed) return;
    this.error = error instanceof Error ? error : new Error(String(error));
    this.player.log.error(`overtone: ${this.error.message}`);
    this.doc = undefined;
    this.show(-1);
    this.layer.classList.add('ot-error');
    this.button?.hide();
    this.restoreNativeButtons();
    this.restoreNativeTracks();
    this.host.removeEventListener('keydown', this.onKeyDown, true); // the `c` key is a captions control too
  }

  /** Puts replaced video.js caption buttons back, just before the (hidden) Overtone button. */
  private restoreNativeButtons(): void {
    const controlBar = this.player.getChild('ControlBar');
    const names = replacedButtons.get(this.player);
    if (!controlBar || !names) return;
    replacedButtons.delete(this.player);
    const at = this.button ? controlBar.children().indexOf(this.button) : -1;
    let index = at >= 0 ? at : controlBar.children().length;
    for (const name of names) {
      if (controlBar.getChild(name)) continue;
      controlBar.addChild(name, {}, index++);
    }
  }

  /**
   * Keeps the page's own caption tracks off: they would double the overlay, and their menu is gone. video.js turns a
   * `<track default>` back on at every `loadedmetadata`, and native text tracks may turn on by themselves.
   */
  private readonly watchNativeTracks = (): void => {
    if (this.disposed || this.error || this.player.isDisposed()) return;
    this.silenceNativeTracks();
    this.watchedTracks = this.player.textTracks() as unknown as EventTarget;
    this.watchedTracks.addEventListener('change', this.silenceNativeTracks); // fires a task later
    // Runs right after video.js's own listener (added first), so a default track does not flash for a frame.
    this.player.on('loadedmetadata', this.silenceNativeTracks);
  };

  /**
   * Turns off every showing captions/subtitles track except our fallback tracks. Skipped in iOS native fullscreen,
   * where the native menu is the viewer's only control.
   */
  private readonly silenceNativeTracks = (): void => {
    if (isNativeIOSFullscreen(this.player)) return;
    // video.js's TextTrackList type has no index signature; at runtime it is indexed like the DOM's.
    const tracks = this.player.textTracks() as unknown as ArrayLike<TextTrack>;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]!;
      if (track.kind !== 'captions' && track.kind !== 'subtitles') continue;
      if (track.mode !== 'showing' || this.fallback.owns(track)) continue;
      if (!this.silencedTracks.some((silenced) => silenced.track === track)) this.silencedTracks.push({ track, mode: track.mode });
      track.mode = 'disabled';
    }
  };

  /** A track turned on in iOS native fullscreen goes off again when it ends and the overlay is back. */
  private readonly onFullscreenChange = (): void => {
    if (this.watchedTracks) this.silenceNativeTracks();
  };

  /** Gives the page's tracks their mode back (failed load or manual dispose). */
  private restoreNativeTracks(): void {
    this.unwatchNativeTracks();
    for (const { track, mode } of this.silencedTracks) {
      if (track.mode === 'disabled') track.mode = mode;
    }
    this.silencedTracks = [];
  }

  private unwatchNativeTracks(): void {
    this.watchedTracks?.removeEventListener('change', this.silenceNativeTracks);
    this.watchedTracks = undefined;
    this.player.off('loadedmetadata', this.silenceNativeTracks);
  }

  private readonly onPlayerDispose = (): void => {
    this.playerDisposing = true;
    this.dispose();
  };

  private load(): Promise<OvertoneDocument> {
    const { data, src } = this.options;
    if (data) return Promise.resolve().then(() => assertValid(data));
    if (!src) return Promise.reject(new Error('pass `src` (URL of a .overtone.json file) or `data`'));
    return fetch(src)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${src}`);
        return response.json();
      })
      .then((json: unknown) => assertValid(json));
  }

  /** Removes video.js's own caption buttons and puts the Overtone button where they were. */
  private addButton(): OvertoneCaptionsButton | undefined {
    const controlBar = this.player.getChild('ControlBar');
    if (!controlBar) return undefined;
    let index = Math.min(buttonSlots.get(this.player) ?? Infinity, controlBar.children().length);
    const replaced = replacedButtons.get(this.player) ?? [];
    for (const name of NATIVE_CAPTION_BUTTONS) {
      const native = controlBar.getChild(name);
      if (!native) continue;
      if (!replaced.includes(name)) replaced.push(name);
      // Removed, not hidden: video.js would show its menu again as soon as a text track is added.
      index = Math.min(index, controlBar.children().indexOf(native));
      controlBar.removeChild(native);
      native.dispose();
    }
    if (replaced.length > 0) replacedButtons.set(this.player, replaced);
    const button = new OvertoneCaptionsButton(this.player, { mode: this.mode, onCycle: () => this.cycle() });
    controlBar.addChild(button, {}, index);
    return button;
  }

  private applyMode(): void {
    this.layer.classList.remove('ot-mode-off', 'ot-mode-styled', 'ot-mode-plain');
    this.layer.classList.add(`ot-mode-${this.mode}`);
    this.button?.update(this.mode);
    this.update();
    this.fallback.sync();
  }

  /** Renders cue `index` of the current profile (-1 = nothing). Re-renders only when the cue changes. */
  private show(index: number): void {
    if (index === this.cueIndex) return;
    this.cueIndex = index;
    this.cueEl =
      index === -1 || !this.doc || !this.profile
        ? null
        : renderCue(this.doc, this.profile, index, { speakers: this.options.speakers });
    this.layer.replaceChildren(...(this.cueEl ? [this.cueEl] : []));
  }

  /** Per-frame loop while playing; `frame` is 0 when it does not run. */
  private readonly startLoop = (): void => {
    if (this.frame !== 0) return;
    const tick = () => {
      this.update();
      // A source change while playing fires no `pause`.
      if (this.player.paused()) {
        this.frame = 0;
        return;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  };

  private readonly stopLoop = (): void => {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.update();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!isCaptionsKey(event)) return;
    event.preventDefault();
    this.cycle();
  };
}
