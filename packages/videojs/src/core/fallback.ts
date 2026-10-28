import videojs from 'video.js';
import type { Player } from '../video-types.js';

/** A native text track holding a profile's .vtt, used only in iOS native fullscreen. */
export interface FallbackTrack { profileId: string; track: TextTrack }

/** The language's own name ("English", "Nederlands"), or undefined when unknown. */
function languageName(language: string): string | undefined {
  // "und" would come out as "Unknown language".
  if (!language.trim() || /^und($|-)/i.test(language.trim())) return undefined;
  try {
    const names = typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([language], { type: 'language' }) : undefined;
    return names?.of(language) || undefined;
  } catch {
    return undefined; // not a valid language tag
  }
}

/**
 * The label in iOS's native captions menu: "English" / "English (phone)" for the horizontal/vertical pair, else the
 * profile's description or id.
 */
export function fallbackLabel(language: string, profileId: string, profileIds: readonly string[], description?: string): string {
  const isUsualPair = profileIds.length === 2 && profileIds.includes('horizontal') && profileIds.includes('vertical');
  if (!isUsualPair) return description || profileId;
  const name = languageName(language) ?? 'Captions';
  return profileId === 'vertical' ? `${name} (phone)` : name;
}

/**
 * Adds a disabled native captions track per `fallbackTracks` entry, kept across source changes (remove with
 * `removeFallbackTracks`). Entries are skipped while the tech is not ready.
 */
export function addFallbackTracks(
  player: Player,
  language: string,
  urls: Record<string, string>,
  descriptions: Readonly<Record<string, string | undefined>> = {},
): FallbackTrack[] {
  const added: FallbackTrack[] = [];
  const ids = Object.keys(urls);
  for (const [profileId, src] of Object.entries(urls)) {
    const trackEl = player.addRemoteTextTrack(
      { kind: 'captions', src, srclang: language, label: fallbackLabel(language, profileId, ids, descriptions[profileId]), mode: 'disabled' },
      true,
    );
    // video.js's type omits `track`; the element is undefined while the tech is not ready.
    const track = (trackEl as unknown as { track?: TextTrack } | undefined)?.track;
    if (track) added.push({ profileId, track });
  }
  return added;
}

/** Removes the tracks added by `addFallbackTracks`; does nothing on a disposed player. */
export function removeFallbackTracks(player: Player, tracks: readonly FallbackTrack[]): void {
  if (player.isDisposed?.()) return;
  for (const { track } of tracks) player.removeRemoteTextTrack(track);
}

/** True where text tracks are native (Safari, iOS), the only place a fallback track can show. */
export function usesNativeTextTracks(player: Player): boolean {
  // `true` silences video.js's "using the tech directly" warning.
  return Boolean(player.tech(true)?.featuresNativeTextTracks) || videojs.browser.IS_IOS;
}

/** True in iOS Safari's native fullscreen, where the overlay cannot render (video.js adds `vjs-ios-native-fs`). */
export function isNativeIOSFullscreen(player: Player): boolean {
  return Boolean(player.isFullscreen()) && player.hasClass('vjs-ios-native-fs');
}

/** Shows the active profile's track when `show` is true; disables all others. */
export function syncFallbackTracks(tracks: readonly FallbackTrack[], activeProfileId: string | undefined, show: boolean): void {
  for (const { profileId, track } of tracks) {
    track.mode = show && profileId === activeProfileId ? 'showing' : 'disabled';
  }
}
