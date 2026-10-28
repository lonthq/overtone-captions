/* global videojs, loadStylePacks, retryOnMediaError */
// Demo: a 16:9 and a 9:16 player with a theme switch over every style pack. `?theme=<name>` (default social),
// `?clip=<name>` (default tears-of-steel; see CLIPS). Videos stream from their publishers.
// NASA's original (800x450) rather than the ~mobile file the captions were timed on: same audio timeline, 0 ms offset.
const NASA_VIDEO = 'https://images-assets.nasa.gov/video/ksc_053108_sts124_dutton/ksc_053108_sts124_dutton~orig.mp4';
// The files the captions were made from. The H.264 .mov files are declared video/mp4: Chrome answers "" to
// canPlayType('video/quicktime') but plays them.
const BLENDER_VIDEOS = {
  'tears-of-steel': 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov',
  'elephants-dream': 'https://download.blender.org/ED/elephantsdream-720-h264-st-aac.mov',
  'cosmos-laundromat': 'https://download.blender.org/gooseberry/movies/cosmos_laundromat_720p.mp4',
};

/** A clip with live output in examples/output/<folder>/<name>.*, streamed from `video` in a 16:9 and a 9:16 player. */
function streamedClip(folder, name, video) {
  const base = `/examples/output/${folder}/${name}`;
  return {
    captions: `${base}.overtone.json`,
    players: [
      {
        id: 'player-16x9',
        src: video,
        aspectRatio: '16:9',
        fallbackTracks: { horizontal: `${base}.horizontal.vtt`, vertical: `${base}.vertical.vtt` },
      },
      {
        // No vertical edit exists: the widescreen video, center-cropped (.crop), shows the vertical profile.
        id: 'player-9x16',
        src: video,
        aspectRatio: '9:16',
        crop: true,
      },
    ],
  };
}

const CLIPS = {
  nasa: streamedClip('nasa', 'nasa-dutton', NASA_VIDEO),
  ...Object.fromEntries(Object.entries(BLENDER_VIDEOS).map(([name, video]) => [name, streamedClip(name, name, video)])),
};
const params = new URLSearchParams(location.search);
const clipName = Object.hasOwn(CLIPS, params.get('clip')) ? params.get('clip') : 'tears-of-steel';
// Speaker names off by default: automatic labels can be "S7"-style. `?speakers=1` shows them.
const showSpeakers = params.get('speakers') === '1';
const { captions: CAPTIONS, players: PLAYERS } = CLIPS[clipName];

const themeSelect = document.getElementById('theme');
const controllers = [];

/** Fills the theme menu from the style packs and selects `?theme=` when it names one. */
async function setUpThemes() {
  try {
    const packs = await loadStylePacks();
    themeSelect.replaceChildren(...packs.map((pack) => new Option(pack.title, pack.name)));
  } catch (error) {
    console.warn(`Style packs not loaded, only the default theme is available: ${error.message}`);
  }
  const wanted = params.get('theme');
  themeSelect.value = [...themeSelect.options].some((option) => option.value === wanted) ? wanted : 'social';
}

/** After a video failed twice: one message above the players, linking to the other clips. */
function showLoadError(src) {
  const box = document.getElementById('load-error');
  if (!box.hidden) return;
  document.getElementById('load-error-host').textContent = new URL(src).hostname;
  document.getElementById('load-error-retry').href = location.href;
  const links = [...document.querySelectorAll('#clip-switch a')]
    .filter((link) => link.id !== `link-${clipName}`)
    .map((link) => Object.assign(document.createElement('a'), { href: link.href, textContent: link.textContent }));
  const clips = document.getElementById('load-error-clips');
  clips.replaceChildren(...links.flatMap((link, i) => (i ? [' · ', link] : [link])));
  box.hidden = false;
}

async function main() {
  await setUpThemes();
  document.body.dataset.clip = clipName;
  document.getElementById(`link-${clipName}`).setAttribute('aria-current', 'page');
  for (const intro of document.querySelectorAll('[id^="intro-"]')) intro.hidden = intro.id !== `intro-${clipName}`;
  for (const { id, src, aspectRatio, fallbackTracks, crop } of PLAYERS) {
    const source = { src, type: 'video/mp4' };
    const player = videojs(id, { fluid: true, aspectRatio, sources: [source] });
    retryOnMediaError(player, source, () => showLoadError(src));
    if (crop) player.addClass('crop');
    const controller = player.overtone({
      src: CAPTIONS,
      theme: themeSelect.value,
      fallbackTracks,
      speakers: showSpeakers ? 'change' : 'never',
    });
    controllers.push(controller);
    // Keep both players in the same mode. No loop: setMode() fires overtone:modechange only on a change.
    player.on('overtone:modechange', (event) => {
      for (const other of controllers) if (other !== controller) other.setMode(event.mode);
    });
  }
}

const speakersBox = document.getElementById('speakers');
speakersBox.checked = showSpeakers;
speakersBox.addEventListener('change', () => {
  // Read only when the plugin starts, so reload.
  if (speakersBox.checked) params.set('speakers', '1');
  else params.delete('speakers');
  location.search = params.toString();
});

themeSelect.addEventListener('change', () => {
  for (const controller of controllers) controller.setTheme(themeSelect.value);
  // Survives a reload or a shared link.
  params.set('theme', themeSelect.value);
  history.replaceState(null, '', `?${params}`);
});

main();
