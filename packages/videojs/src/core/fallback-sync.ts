import type { Player } from '../video-types.js';
import type { Tech } from '../video-types.js';
import {
  addFallbackTracks,
  isNativeIOSFullscreen,
  removeFallbackTracks,
  syncFallbackTracks,
  usesNativeTextTracks,
  type FallbackTrack,
} from './fallback.js';

/** One controller's native fallback tracks: added where text tracks are native, shown only in iOS native fullscreen. */
export class FallbackSync {
  private readonly player: Player;
  private readonly urls: Record<string, string>;
  private readonly activeProfileId: () => string | undefined;
  private readonly fullscreenListener: (() => void) | undefined;
  private tracks: FallbackTrack[] = [];
  /** The tech whose events we follow; it can change with the source. */
  private tech: Tech | undefined;
  private textTracks: EventTarget | undefined;
  private disposed = false;

  /**
   * @param urls profile id → .vtt URL (the `fallbackTracks` option)
   * @param activeProfileId the profile whose track may show; undefined while captions are off
   * @param onFullscreenChange called after each sync on a player or tech `fullscreenchange`
   */
  constructor(
    player: Player,
    urls: Record<string, string>,
    activeProfileId: () => string | undefined,
    onFullscreenChange?: () => void,
  ) {
    this.player = player;
    this.urls = urls;
    this.activeProfileId = activeProfileId;
    this.fullscreenListener = onFullscreenChange;
    player.on('fullscreenchange', this.onFullscreenChange);
    player.on(['ready', 'loadstart'], this.bindTech);
    this.bindTech();
  }

  /** Adds the tracks once the tech is ready. Skipped where text tracks are emulated: they could never show. */
  add(language: string, profiles: readonly { id: string; description?: string }[] = []): void {
    this.player.ready(() => {
      if (this.disposed || this.player.isDisposed() || !usesNativeTextTracks(this.player)) return;
      this.tracks = addFallbackTracks(this.player, language, this.urls, Object.fromEntries(profiles.map((p) => [p.id, p.description])));
      this.sync();
    }, true);
  }

  /** Shows the active profile's track only in iOS native fullscreen; disables the others. */
  readonly sync = (): void => {
    const profileId = this.activeProfileId();
    syncFallbackTracks(this.tracks, profileId, profileId !== undefined && isNativeIOSFullscreen(this.player));
  };

  /** True for one of our fallback tracks. */
  owns(track: TextTrack): boolean {
    return this.tracks.some((fallback) => fallback.track === track);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.player.off('fullscreenchange', this.onFullscreenChange);
    this.player.off(['ready', 'loadstart'], this.bindTech);
    this.unbindTech();
    removeFallbackTracks(this.player, this.tracks);
    this.tracks = [];
  }

  private readonly onFullscreenChange = (): void => {
    this.sync();
    this.fullscreenListener?.();
  };

  /**
   * WebKit may show a track on its own (accessibility settings), doubling the overlay: turn it off again outside
   * native fullscreen. No loop: setting a mode to its current value fires no `change`.
   */
  private readonly onTracksChange = (): void => {
    if (!isNativeIOSFullscreen(this.player)) this.sync();
  };

  /** Follows the tech's `fullscreenchange`: on iPadOS video.js fires none on the player for native fullscreen. */
  private readonly bindTech = (): void => {
    const tech = this.player.tech(true) as Tech | undefined;
    if (tech === this.tech) return;
    this.unbindTech();
    if (!tech) return;
    this.tech = tech;
    // The player's listener runs first, so `vjs-ios-native-fs` and isFullscreen() are up to date here.
    tech.on('fullscreenchange', this.onFullscreenChange);
    this.textTracks = this.player.textTracks() as unknown as EventTarget;
    this.textTracks.addEventListener('change', this.onTracksChange);
  };

  private unbindTech(): void {
    if (this.tech && !this.tech.isDisposed()) this.tech.off('fullscreenchange', this.onFullscreenChange);
    this.textTracks?.removeEventListener('change', this.onTracksChange);
    this.tech = undefined;
    this.textTracks = undefined;
  }
}
