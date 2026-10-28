// The `overtone burn` caption page (dist/burn/page.js, run in headless Chrome). Renders captions with the player's
// own code (videojs-overtone/core) and runs CSS transitions on a virtual clock.
import { applyProfileToLayer, cueIndexAt, renderCue, updateActiveWords, type CaptionMode, type SpeakerDisplay } from 'videojs-overtone/core';
import type { OvertoneDocument, Profile } from 'overtone-format';

export interface PageOptions {
  doc: OvertoneDocument;
  profileId: string;
  mode: Exclude<CaptionMode, 'off'>;
  speakers: SpeakerDisplay;
  theme: string;
  width: number;
  height: number;
  /** Stylesheets in order: base.css, the pack, an optional font rule. */
  css: string[];
}

let doc: OvertoneDocument;
let profile: Profile;
let speakers: SpeakerDisplay;
let layer: HTMLElement;
let cueIndex = -1;
let cueEl: HTMLElement | null = null;
/** Running finite animations and their virtual start time (s). */
const running = new Map<Animation, number>();
/** Animations already handled. */
const seen = new WeakSet<Animation>();

/** Builds the page; resolves with the font families that failed to load (the driver decides which matter). */
async function init(o: PageOptions): Promise<string[]> {
  doc = o.doc;
  const found = o.doc.profiles.find((p) => p.id === o.profileId);
  if (!found) throw new Error(`no profile "${o.profileId}" in the document`);
  profile = found;
  speakers = o.speakers;
  // captions inherit border-box sizing inside video.js; match it
  for (const css of ['.ot-picture *, .ot-picture *::before, .ot-picture *::after { box-sizing: inherit; }', ...o.css]) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }
  document.documentElement.style.background = 'transparent';
  document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
  const picture = document.createElement('div');
  picture.className = 'ot-picture';
  // the picture is exactly the video's size (overrides base.css's absolute/inset 0); the rest mirrors what a
  // video.js player passes down (border-box, 10px font size, line-height 1)
  picture.style.cssText = `position:relative;inset:auto;width:${o.width}px;height:${o.height}px;overflow:hidden;` +
    'box-sizing:border-box;font-size:10px;line-height:1';
  layer = document.createElement('div');
  layer.className = `ot-layer ot-theme-${o.theme} ot-mode-${o.mode}`;
  applyProfileToLayer(layer, profile);
  picture.append(layer);
  document.body.append(picture);
  // fonts load lazily; load all now so the first caption is not drawn in a fallback
  const failed: string[] = [];
  await Promise.all([...document.fonts].map((face) => face.load().catch(() => failed.push(face.family.replace(/^["']|["']$/g, '')))));
  await document.fonts.ready;
  return failed;
}

/** Moves tracked animations to virtual time `t`, dropping finished or cancelled ones. True while any runs. */
function step(t: number): boolean {
  for (const [animation, start] of running) {
    const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
    const local = (t - start) * 1000;
    if (animation.playState === 'idle' || local >= end) {
      if (animation.playState !== 'idle') animation.finish();
      running.delete(animation);
    } else {
      animation.currentTime = local;
    }
  }
  return running.size > 0;
}

/**
 * Shows the state at `t` like the player's update() and pauses any transitions it started. `started` (set only when
 * true) tells the driver to follow them from `t`.
 */
function setTime(t: number): { key: string; animating: boolean; started?: true } {
  step(t);
  const index = cueIndexAt(profile, t);
  if (index !== cueIndex) {
    cueIndex = index;
    cueEl = index === -1 ? null : renderCue(doc, profile, index, { speakers });
    layer.replaceChildren(...(cueEl ? [cueEl] : []));
  }
  if (cueEl) updateActiveWords(cueEl, t);
  // getAnimations() flushes styles, so this change's transitions exist now
  const added: Animation[] = [];
  for (const animation of document.getAnimations()) {
    if (seen.has(animation)) continue;
    seen.add(animation);
    animation.pause();
    animation.currentTime = 0;
    // an infinite animation would make every frame "animating": keep it paused at its start
    if (Number(animation.effect?.getComputedTiming().endTime) === Infinity) continue;
    running.set(animation, t);
    added.push(animation);
  }
  // the flush cancelled animations of a replaced cue or a reversed transition
  for (const animation of running.keys()) if (animation.playState === 'idle') running.delete(animation);
  const active = cueEl ? [...cueEl.querySelectorAll('.ot-word')].flatMap((w, i) => (w.classList.contains('ot-active') ? [i] : [])) : [];
  const started = added.some((animation) => running.has(animation));
  return { key: `${cueIndex}:${active.join(',')}`, animating: running.size > 0, ...(started ? { started: true as const } : {}) };
}

declare global {
  interface Window { overtoneBurn: { init: typeof init; setTime: typeof setTime; step: typeof step } }
}
window.overtoneBurn = { init, setTime, step };
