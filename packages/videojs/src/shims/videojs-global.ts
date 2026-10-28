// IIFE build only: `import videojs from 'video.js'` resolves here, to the page's global, instead of a bundled copy.
import type videojsType from 'video.js';

const videojs = (globalThis as unknown as { videojs?: typeof videojsType }).videojs;
if (!videojs) {
  throw new Error('videojs-overtone: load video.js before index.global.js');
}
export default videojs;
