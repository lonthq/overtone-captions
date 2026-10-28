/* global OvertoneVideojs, loadStylePacks */
// Style gallery: every pack as static caption frames, drawn with the player's own renderCue().
//   /examples/styles/                       each class at 16:9 and 9:16, styled and plain, a spoken cue, a line-fit check
//   /examples/styles/?pack=minimal,social   only these packs
//   /examples/styles/?view=overview         one row per pack at 16:9, 1:1 and 9:16 (source of the preview images)
const FIXTURE = '/examples/fixtures/sample.overtone.json';
const SQUARE = '/examples/fixtures/square/sample.overtone.json';
// Every cue is rendered off-screen to check that no line wraps; the NASA output has longer lines.
const FIT_DOCS = [FIXTURE, SQUARE, '/examples/output/nasa/nasa-dutton.overtone.json'];
const CLASSES = ['emphasis', 'key', 'brand', 'number', 'soft'];
const VIEWS = [
  { aspect: '16 / 9', label: '16:9 styled', profile: 'horizontal', mode: 'styled' },
  { aspect: '16 / 9', label: '16:9 plain', profile: 'horizontal', mode: 'plain' },
  { aspect: '9 / 16', label: '9:16 styled', profile: 'vertical', mode: 'styled' },
  { aspect: '9 / 16', label: '9:16 plain', profile: 'vertical', mode: 'plain' },
];
// A small 16:9 embed, a 1:1 feed post, the narrowest phone player.
const FIT_WIDTHS = { '16:9': 480, '1:1': 360, '9:16': 270 };

const params = new URLSearchParams(location.search);
const view = params.get('view') === 'overview' ? 'overview' : 'full';
const onlyPacks = params.get('pack')?.split(',').filter(Boolean);

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const wordsOf = (doc) => doc.turns.flatMap((turn) => turn.words);

/** The first cue with a word of class `cls` (preferably that class alone), and the time it is spoken. */
function findExample(doc, profile, cls) {
  const words = wordsOf(doc);
  const search = (onlyThisClass) => {
    for (const [cueIndex, cue] of profile.cues.entries()) {
      for (const line of cue.lines) {
        for (let i = line.words[0]; i <= line.words[1]; i++) {
          const classes = words[i].classes ?? [];
          if (classes.includes(cls) && (!onlyThisClass || classes.length === 1)) {
            return { cueIndex, time: words[i].start + 0.01 };
          }
        }
      }
    }
    return null;
  };
  return search(true) ?? search(false);
}

/** A player-sized scene with one rendered cue. */
function frame(doc, pack, { aspect, profile: profileId, mode, label, width }, example, speakers = 'never') {
  const profile = doc.profiles.find((p) => p.id === profileId);
  const figure = el('figure', `frame frame-${profileId}`);
  const screen = el('div', 'screen ot-host ot-picture');
  screen.style.aspectRatio = aspect;
  if (width) screen.style.width = `${width}px`;
  const layer = el('div', `ot-layer ot-theme-${pack.name} ot-mode-${mode}`);
  OvertoneVideojs.applyProfileToLayer(layer, profile);
  if (example) {
    const cue = OvertoneVideojs.renderCue(doc, profile, example.cueIndex, { speakers });
    OvertoneVideojs.updateActiveWords(cue, example.time);
    layer.append(cue);
  }
  screen.append(layer);
  figure.append(screen);
  if (label) figure.append(el('figcaption', '', label));
  return figure;
}

// The "spoken" row replays each cue, with a pause in seconds before it starts again.
const PLAY_PAUSE = 1;
const playing = [];

function playCue(figure, cue) {
  playing.push({ cueEl: figure.querySelector('.ot-cue'), start: cue.start, length: cue.end - cue.start + PLAY_PAUSE });
}

function tick(now) {
  for (const { cueEl, start, length } of playing) OvertoneVideojs.updateActiveWords(cueEl, start + ((now / 1000) % length));
  requestAnimationFrame(tick);
}

/** Whether a rendered .ot-line runs onto a second row. */
function wraps(line) {
  const style = getComputedStyle(line);
  const inner = line.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return inner > parseFloat(style.lineHeight) * 1.5;
}

function packInfo(pack, headingTag) {
  const info = el('div', 'pack-info');
  const heading = el(headingTag, '', pack.title);
  heading.append(' ', el('code', '', pack.name));
  const tags = el('p', 'tags');
  for (const tag of pack.tags) tags.append(el('span', 'tag', tag));
  info.append(heading, el('p', 'note', pack.description), tags);
  return info;
}

function metaLine(pack) {
  const meta = el('p', 'meta');
  meta.append(
    `By ${pack.author} · lowest text contrast ${pack.lowestContrast}:1 · `,
    el('code', '', pack.source),
  );
  return meta;
}

function fullSection(doc, pack) {
  const section = el('section', 'pack');
  section.id = pack.name;
  section.append(packInfo(pack, 'h2'), metaLine(pack));
  const rows = [
    ...CLASSES.map((cls) => ({ label: cls, find: (profile) => findExample(doc, profile, cls), speakers: 'never' })),
    { label: 'speaker', find: () => ({ cueIndex: 0, time: -1 }), speakers: 'always' },
    // Played word by word, to show the motion on .ot-active.
    { label: 'spoken', find: (profile) => findExample(doc, profile, 'emphasis'), speakers: 'never', play: true },
  ];
  for (const row of rows) {
    const line = el('div', 'row');
    const heading = el('h3');
    heading.append(el('code', '', row.label));
    line.append(heading);
    for (const v of VIEWS) {
      const profile = doc.profiles.find((p) => p.id === v.profile);
      const example = row.find(profile);
      const figure = frame(doc, pack, v, example, row.speakers);
      if (row.play && example) playCue(figure, profile.cues[example.cueIndex]);
      line.append(figure);
    }
    section.append(line);
  }
  const fit = el('p', 'fit', 'Checking line fit…');
  fit.dataset.pack = pack.name;
  section.append(fit);
  return section;
}

function overviewRow(doc, square, pack) {
  const row = el('section', 'overview-row');
  row.dataset.pack = pack.name;
  const frames = el('div', 'frames');
  const horizontal = doc.profiles.find((p) => p.id === 'horizontal');
  const vertical = doc.profiles.find((p) => p.id === 'vertical');
  const squareProfile = square.profiles[0];
  frames.append(
    frame(doc, pack, { aspect: '16 / 9', profile: 'horizontal', mode: 'styled', label: '16:9' }, findExample(doc, horizontal, 'brand'), 'always'),
    frame(square, pack, { aspect: '1 / 1', profile: squareProfile.id, mode: 'styled', label: '1:1' }, findExample(square, squareProfile, 'number')),
    // No spoken word, so the key-word highlight reads as one strip.
    frame(doc, pack, { aspect: '9 / 16', profile: 'vertical', mode: 'styled', label: '9:16' }, { ...findExample(doc, vertical, 'key'), time: -1 }),
  );
  row.append(packInfo(pack, 'h2'), frames);
  return row;
}

/** Renders every cue of every FIT_DOCS document off-screen per pack and reports lines that wrap. */
async function checkFit(packs) {
  const lab = el('div', 'fit-lab');
  lab.setAttribute('aria-hidden', 'true');
  document.body.append(lab);
  const docs = [];
  for (const url of FIT_DOCS) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) docs.push(await response.json());
  }
  const results = new Map();
  for (const pack of packs) {
    const wrapped = [];
    let total = 0;
    for (const doc of docs) {
      for (const profile of doc.profiles) {
        const width = FIT_WIDTHS[profile.aspect] ?? FIT_WIDTHS['16:9'];
        const aspect = profile.aspect.replace(':', ' / ');
        const settings = { aspect, profile: profile.id, mode: 'styled', width };
        const frames = profile.cues.map((_, cueIndex) => frame(doc, pack, settings, { cueIndex, time: -1 }));
        lab.replaceChildren(...frames);
        for (const line of lab.querySelectorAll('.ot-line')) {
          total++;
          if (wraps(line)) wrapped.push(`${profile.id}: "${line.textContent.trim()}"`);
        }
      }
    }
    results.set(pack.name, { total, wrapped });
  }
  lab.remove();
  return { results, docs: docs.length };
}

async function main() {
  if (typeof OvertoneVideojs === 'undefined') {
    throw new Error('packages/videojs/dist is missing — run npm run build (or npm run styles:dev)');
  }
  document.body.classList.add(`view-${view}`);
  const [allPacks, doc, square] = await Promise.all([
    loadStylePacks(),
    fetch(FIXTURE).then((response) => response.json()),
    fetch(SQUARE).then((response) => response.json()),
  ]);
  const packs = onlyPacks ? allPacks.filter((pack) => onlyPacks.includes(pack.name)) : allPacks;
  const root = document.getElementById('gallery');
  if (view === 'overview') {
    const cta = el('section', 'overview-row cta');
    cta.innerHTML =
      '<div class="pack-info"><h2>Your pack here</h2><p class="note">A style pack is one CSS file and a pack.json. ' +
      'See <code>docs/contributing/style-packs.md</code>.</p></div>';
    root.replaceChildren(...packs.map((pack) => overviewRow(doc, square, pack)), ...(onlyPacks ? [] : [cta]));
  } else {
    const nav = document.getElementById('pack-nav');
    nav.replaceChildren(
      ...allPacks.map((pack) => {
        const link = el('a', '', pack.title);
        link.href = `?pack=${encodeURIComponent(pack.name)}`;
        return link;
      }),
    );
    nav.append(el('span', 'sep', '·'), Object.assign(el('a', '', 'all packs'), { href: '?' }), Object.assign(el('a', '', 'overview'), { href: '?view=overview' }));
    root.replaceChildren(...packs.map((pack) => fullSection(doc, pack)));
    if (playing.length) requestAnimationFrame(tick);
  }
  await document.fonts.ready;
  let wrappedFrames = 0;
  for (const figure of root.querySelectorAll('.frame')) {
    if ([...figure.querySelectorAll('.ot-line')].some(wraps)) {
      figure.classList.add('wraps');
      wrappedFrames++;
    }
  }
  const widths = Object.entries(FIT_WIDTHS).map(([aspect, width]) => `${width}px ${aspect}`).join(', ');
  if (view === 'full') {
    const { results, docs } = await checkFit(packs);
    for (const [name, { total, wrapped }] of results) {
      const fit = root.querySelector(`.fit[data-pack="${name}"]`);
      fit.classList.toggle('bad', wrapped.length > 0);
      fit.textContent = wrapped.length
        ? `Line fit: ${wrapped.length} of ${total} lines wrap (${widths}): ${wrapped.slice(0, 5).join('; ')}${wrapped.length > 5 ? '…' : ''}`
        : `Line fit: all ${total} lines of ${docs} documents fit on one row (${widths}).`;
      wrappedFrames += wrapped.length;
    }
  }
  // Read by previews.mjs.
  document.body.dataset.wraps = String(wrappedFrames);
  document.body.dataset.ready = 'true';
}

main().catch((error) => {
  document.getElementById('gallery').textContent = `Could not build the gallery: ${error.message}`;
  document.body.dataset.error = error.message;
});
