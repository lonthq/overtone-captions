import { describe, expect, it } from 'vitest';
import { pictureRect } from '../src/core/index';

/** pictureRect returns the visible picture (spec §14.3): a video larger than the box (`none`) is clipped to it. */
describe('pictureRect by object-fit', () => {
  const box = { width: 640, height: 360 };
  const whole = { left: 0, top: 0, width: 640, height: 360 };
  const small = { width: 320, height: 240 }; // fits inside the box at its own size
  const large = { width: 1080, height: 1080 }; // larger than the box

  it('contain: scales the video to fit and centers it', () => {
    expect(pictureRect(box, small, 'contain')).toEqual({ left: 80, top: 0, width: 480, height: 360 });
    expect(pictureRect(box, large, 'contain')).toEqual({ left: 140, top: 0, width: 360, height: 360 });
  });

  it('cover: the whole box (the video is cropped to fill it)', () => {
    expect(pictureRect(box, small, 'cover')).toEqual(whole);
    expect(pictureRect(box, large, 'cover')).toEqual(whole);
  });

  it('fill: the whole box (the video is stretched to fill it)', () => {
    expect(pictureRect(box, small, 'fill')).toEqual(whole);
    expect(pictureRect(box, large, 'fill')).toEqual(whole);
  });

  it('none: the video at its own size, centered', () => {
    expect(pictureRect(box, small, 'none')).toEqual({ left: 160, top: 60, width: 320, height: 240 });
  });

  it('none: a video larger than the box is clipped to the box', () => {
    // 1080 x 1080 centered in 640 x 360 overflows on all sides: all of the box shows video.
    expect(pictureRect(box, large, 'none')).toEqual(whole);
    // 400 x 1000 overflows only at the top and bottom.
    expect(pictureRect(box, { width: 400, height: 1000 }, 'none')).toEqual({ left: 120, top: 0, width: 400, height: 360 });
  });

  it('scale-down: the smaller of none and contain', () => {
    expect(pictureRect(box, small, 'scale-down')).toEqual(pictureRect(box, small, 'none'));
    expect(pictureRect(box, small, 'scale-down')).toEqual({ left: 160, top: 60, width: 320, height: 240 });
    expect(pictureRect(box, large, 'scale-down')).toEqual(pictureRect(box, large, 'contain'));
    expect(pictureRect(box, large, 'scale-down')).toEqual({ left: 140, top: 0, width: 360, height: 360 });
  });

  it('an unknown or empty object-fit counts as contain (the default of a video element)', () => {
    expect(pictureRect(box, small, '')).toEqual(pictureRect(box, small, 'contain'));
    expect(pictureRect(box, small, 'bogus')).toEqual(pictureRect(box, small, 'contain'));
  });
});
