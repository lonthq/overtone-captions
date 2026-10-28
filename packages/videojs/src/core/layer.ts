import { parseAspect, type Profile } from 'overtone-format';

/** A profile id or theme name as a valid class token: anything outside [A-Za-z0-9_-] becomes '-'. */
export function classToken(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Sets `ot-profile-<id>`, `--ot-chars` (maxCharsPerLine, sizes the text) and `ot-tall` (aspect below 1) on a caption
 * layer; `undefined` removes them.
 */
export function applyProfileToLayer(layer: HTMLElement, profile: Profile | undefined): void {
  // First, so a malformed aspect throws before the layer is touched.
  const tall = profile ? parseAspect(profile.aspect) < 1 : false;
  for (const cls of [...layer.classList]) if (cls.startsWith('ot-profile-')) layer.classList.remove(cls);
  layer.classList.remove('ot-tall');
  if (!profile) {
    layer.style.removeProperty('--ot-chars');
    return;
  }
  layer.classList.add(`ot-profile-${classToken(profile.id)}`);
  if (tall) layer.classList.add('ot-tall');
  layer.style.setProperty('--ot-chars', String(profile.rules.maxCharsPerLine));
}
