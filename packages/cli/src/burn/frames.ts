import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One image of the caption overlay and the time it starts; it lasts until the next entry. */
export interface FrameEntry { file: string; start: number }

/** The caption page `renderFrames` drives (caption-page.ts implements it over Chrome). */
export interface CaptionPage {
  /** Shows the state at `t`. `key` identifies the static state; `started` is true when animations started. */
  setTime(t: number): Promise<{ key: string; animating: boolean; started?: boolean }>;
  /** Advances running animations to `t`; true while any still runs. */
  step(t: number): Promise<boolean>;
  /** A transparent PNG of the page. */
  screenshot(): Promise<Buffer>;
}

export interface RenderOptions {
  fps: number;
  duration: number;
  dir: string;
  /** Sampling rate of a running transition; default `min(fps, 60)`. */
  animFps?: number;
  /** Stop following an animation after this many seconds; default MAX_ANIMATION_SECONDS. */
  maxAnimSeconds?: number;
  /** Called once per animation cut off at `maxAnimSeconds`, with its start time. */
  onLongAnimation?: (start: number) => void;
  onFrame?: (count: number) => void;
}

const EPS = 1e-6;

export const MAX_ANIMATION_SECONDS = 2;

/**
 * One entry per change of state, plus one per animation frame while a CSS transition runs. Static states are cached
 * by key, so a state that returns reuses its PNG.
 */
export async function renderFrames(page: CaptionPage, events: readonly number[], opts: RenderOptions): Promise<FrameEntry[]> {
  const entries: FrameEntry[] = [];
  const animFps = opts.animFps ?? Math.min(opts.fps, 60);
  const maxAnim = opts.maxAnimSeconds ?? MAX_ANIMATION_SECONDS;
  const byKey = new Map<string, string>();
  let written = 0;
  /** Shot once per static state (`key`), every time for an animation frame (no key). */
  const shoot = async (key: string | undefined): Promise<string> => {
    const cached = key === undefined ? undefined : byKey.get(key);
    if (cached) return cached;
    const file = join(opts.dir, `frame-${String(written++).padStart(6, '0')}.png`);
    await writeFile(file, await page.screenshot());
    if (key !== undefined) byKey.set(key, file);
    opts.onFrame?.(written);
    return file;
  };
  // `animation`: when the running animation began, and whether it was capped at maxAnim (then shot only at events).
  // An event that starts new animations restarts the count, so only one animation running past maxAnim is capped.
  let lastKey: string | undefined;
  let animation: { start: number; capped: boolean } | undefined;
  const add = async (start: number, animating: boolean, key: string): Promise<void> => {
    entries.push({ file: await shoot(animating ? undefined : key), start });
    lastKey = animating ? undefined : key;
  };

  for (let i = 0; i < events.length; i++) {
    const t = events[i];
    const next = events[i + 1] ?? opts.duration;
    const state = await page.setTime(t);
    if (!state.animating) animation = undefined;
    else if (!animation || state.started) animation = { start: t, capped: false };
    if (!state.animating && state.key === lastKey) continue;
    await add(t, state.animating, state.key);
    if (!animation || animation.capped) continue;
    // follow at animFps until it ends, the next event, or maxAnim
    for (let n = Math.floor(t * animFps + EPS) + 1; ; n++) {
      const f = Math.round((n / animFps) * 1e6) / 1e6;
      if (f >= next - EPS) break;
      const animating = await page.step(f);
      await add(f, animating, state.key);
      if (!animating) {
        animation = undefined;
        break;
      }
      if (f - animation.start >= maxAnim - EPS) {
        animation.capped = true;
        opts.onLongAnimation?.(animation.start);
        break;
      }
    }
  }
  return entries;
}
