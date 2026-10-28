// Retries a streamed video once, at the same position: large publisher files (Tears of Steel: 372 MB, index at the
// end) can fail once and play after a reload.

/** MediaError.MEDIA_ERR_ABORTED: stopped on purpose, not a failure. */
const MEDIA_ERR_ABORTED = 1;

/** Reloads `source` ({ src, type }) after the first media error; calls `onGiveUp(error)` on the second. */
function retryOnMediaError(player, source, onGiveUp) {
  let retried = false;
  player.on('error', () => {
    const error = player.error();
    if (!error || error.code === MEDIA_ERR_ABORTED) return;
    if (retried) {
      onGiveUp(error);
      return;
    }
    retried = true;
    const time = player.currentTime();
    // Closes video.js's error overlay.
    player.error(null);
    player.src(source);
    if (time > 0) player.one('loadedmetadata', () => player.currentTime(time));
  });
}
