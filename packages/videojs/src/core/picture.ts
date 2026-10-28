import type { Size } from './profile.js';

export interface Rect { left: number; top: number; width: number; height: number }

/**
 * The visible picture inside `box` by CSS object-fit (spec §14.3), centered and unrounded. `cover`, `fill` and an
 * unknown video size give the whole box; unknown fit values count as `contain`.
 */
export function pictureRect(box: Size, video: Size | undefined, fit: string): Rect {
  const whole = { left: 0, top: 0, width: box.width, height: box.height };
  if (!video || video.width <= 0 || video.height <= 0 || box.width <= 0 || box.height <= 0) return whole;
  if (fit === 'cover' || fit === 'fill') return whole;
  const contain = Math.min(box.width / video.width, box.height / video.height);
  const scale = fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : contain;
  // Only `none` can exceed the box.
  const width = Math.min(video.width * scale, box.width);
  const height = Math.min(video.height * scale, box.height);
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}
