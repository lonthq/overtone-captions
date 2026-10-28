// Adds a stylesheet for every pack in dist/themes/packs.json, so a new pack shows up in the gallery and demo.
const THEMES_URL = '/packages/videojs/dist/themes/';

/** Resolves to the manifest entries ({ name, title, … }) once every stylesheet has loaded. */
async function loadStylePacks() {
  const response = await fetch(`${THEMES_URL}packs.json`);
  if (!response.ok) throw new Error('packages/videojs/dist/themes/packs.json is missing — run npm run build');
  const { packs } = await response.json();
  await Promise.all(
    packs.map(
      (pack) =>
        new Promise((resolve, reject) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = `${THEMES_URL}${pack.css}`;
          link.onload = resolve;
          link.onerror = () => reject(new Error(`could not load ${link.href}`));
          document.head.append(link);
        }),
    ),
  );
  return packs;
}
