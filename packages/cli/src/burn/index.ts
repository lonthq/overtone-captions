import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { closestProfile, getProfile, type OvertoneDocument, type Profile } from 'overtone-format';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { afterPath } from '../media/extract.js';
import { probeVideo, type VideoInfo } from '../media/video.js';
import { baseName, samePath } from '../output.js';
import { onInterrupt } from '../util/interrupt.js';
import { findProfileId, rulesFor, snapAspect } from '../segment/aspect.js';
import { LATEST_RULESET } from '../segment/rulesets/index.js';
import { fontCss, loadStyle } from './assets.js';
import { openCaptionPage } from './caption-page.js';
import { launchChrome, type ChromeTab } from './chrome.js';
import { checkFfmpegVersion, concatList, encode, ffmpegVersion } from './encode.js';
import { captionEvents } from './events.js';
import { MAX_ANIMATION_SECONDS, renderFrames } from './frames.js';

export type SpeakerNames = 'never' | 'change' | 'always';

export interface BurnOptions {
  cwd: string;
  /** Built-in style name or a path to a pack's style.css (default "clean"). */
  style?: string;
  /** Profile id (default: the one closest to the video's shape). */
  profile?: string;
  mode?: 'styled' | 'plain';
  speakerNames?: SpeakerNames;
  font?: string;
  /** --out: file or folder (default: <base>.captioned.mp4 next to the media). */
  output?: string;
  /** The document path as typed, for the recut hint (default "<document>"). */
  documentPath?: string;
}

/** Replaceable parts, for tests. */
export interface BurnDeps {
  probe?: (media: string) => Promise<VideoInfo | undefined>;
  launch?: () => Promise<ChromeTab>;
  /** Returns `ffmpeg -version` output (default: runs ffmpeg). */
  ffmpegVersion?: () => Promise<string>;
  /** Folder for the caption frames (default: the OS temp folder). */
  tmpRoot?: string;
}

const shellWord = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** `--profiles` for the recut hint: the document's profiles (built-in name, else aspect) plus `shape`. */
function recutProfiles(profiles: readonly Profile[], shape: string): string {
  const tokens = profiles.map((p) => (Object.hasOwn(LATEST_RULESET.profiles, p.id) ? p.id : p.aspect));
  const named = Object.entries(LATEST_RULESET.profiles).find(([, p]) => p.aspect === shape)?.[0];
  return [...new Set([...tokens, named ?? shape])].join(',');
}

/** A recut command that adds a profile for `shape`, and the burn to run after it. */
function recutHint(doc: OvertoneDocument, shape: string, documentPath: string | undefined): string {
  const file = documentPath ? shellWord(documentPath) : '<document>';
  const recut = documentPath ? shellWord(`recut/${baseName(documentPath)}.overtone.json`) : 'recut/<document>';
  return `For lines cut for this shape: overtone recut ${file} --profiles ${recutProfiles(doc.profiles, shape)} --export json --out recut/ (then burn ${recut})`;
}

/** Output names burn accepts (MP4-family containers). */
const MP4_NAME = /\.(mp4|m4v|mov)$/i;

/** Burns `doc`'s captions into `media` and returns the written MP4's path. */
export async function burn(media: string, doc: OvertoneDocument, opts: BurnOptions, log: Logger, deps: BurnDeps = {}): Promise<string> {
  media = resolve(opts.cwd, media);
  const info = await stat(media).catch(() => undefined);
  if (!info) throw new UserError(`Media file not found: ${media}`);
  if (info.isDirectory()) throw new UserError(`Media file is a directory: ${media}`);
  if (!info.isFile()) throw new UserError(`Media file is not a regular file: ${media}`);
  const fileName = `${baseName(media)}.captioned.mp4`;
  let output = opts.output ? resolve(opts.cwd, opts.output) : join(dirname(media), fileName);
  // an existing folder, or a path ending in a slash, gets the default file name
  const folder = opts.output !== undefined && (/[\\/]$/.test(opts.output) || (await stat(output).catch(() => undefined))?.isDirectory() === true);
  if (folder) output = join(output, fileName);
  if (samePath(output, media)) throw new UserError(`${output} would overwrite the media file; choose another path with --out.`);
  if (!existsSync(dirname(output))) throw new UserError(`Output folder not found: ${dirname(output)}`);
  if (!MP4_NAME.test(output)) throw new UserError(`${output}: burn writes an MP4 file; give --out a name that ends in .mp4 (or .m4v, .mov), or a folder.`);
  if (doc.profiles.length === 0) throw new UserError('The document has no profiles, so there are no captions to burn in.');
  const video = await (deps.probe ?? probeVideo)(media).catch((err: unknown) => {
    if (err instanceof UserError) throw err;
    const message = (err as Error).message.replace(/^ffprobe failed: /, '');
    throw new UserError(`Cannot read ${media}: not an audio/video file (${afterPath(message, media)})`);
  });
  if (!video) throw new UserError(`${media} has no video stream; burning captions needs a video. For audio, export VTT or SRT instead.`);
  // fail before the screenshots on an ffmpeg that cannot read the caption list
  checkFfmpegVersion(await (deps.ffmpegVersion ?? ffmpegVersion)());
  const duration = video.duration ?? doc.duration;
  if (video.duration === undefined) log.debug(`burn: the video has no duration; using the document's (${doc.duration} s)`);

  // accepts 1:1 or 1x1
  const profileId = opts.profile === undefined ? undefined : findProfileId(doc.profiles.map((p) => p.id), opts.profile);
  let profile = profileId === undefined ? undefined : getProfile(doc, profileId);
  if (opts.profile !== undefined && !profile) {
    throw new UserError(`Unknown profile "${opts.profile}"; the document has: ${doc.profiles.map((p) => p.id).join(', ')}.`);
  }
  let shapeWarning: string | undefined;
  if (!profile) {
    profile = closestProfile(doc.profiles, video.width / video.height)!; // profiles is non-empty (checked above)
    const shape = snapAspect(video.width, video.height);
    if (rulesFor(LATEST_RULESET, shape).maxCharsPerLine !== rulesFor(LATEST_RULESET, profile.aspect).maxCharsPerLine) {
      shapeWarning = `The document has no profile for ${shape} video; using "${profile.id}". ${recutHint(doc, shape, opts.documentPath)}`;
    }
  }

  // fail on a bad --style or --font before Chrome starts or anything is logged
  const style = await loadStyle(opts.style ?? 'clean', opts.cwd);
  const css = [style.css, ...(opts.font ? [await fontCss(opts.font, opts.cwd)] : [])];
  if (shapeWarning) log.warn(shapeWarning);
  if (profile.cues.some((cue) => cue.start >= duration)) log.warn(`Captions after the end of the video (${duration.toFixed(1)} s) are left out.`);
  const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'overtone-burn-'));
  const forget = onInterrupt(() => rmSync(dir, { recursive: true, force: true }));
  let tab: ChromeTab | undefined;
  try {
    tab = await (deps.launch ?? launchChrome)();
    log.info(`burn: ${video.width}×${video.height}, profile ${profile.id}, style ${style.theme}`);
    const page = await openCaptionPage(tab, {
      doc, profileId: profile.id, mode: opts.mode ?? 'styled', speakers: opts.speakerNames ?? 'never',
      theme: style.theme, width: video.width, height: video.height, css,
      ...(opts.font ? { fontPath: resolve(opts.cwd, opts.font) } : {}),
    });
    let warnedLong = false;
    const entries = await renderFrames(page, captionEvents(doc, profile, duration), {
      fps: video.fps, duration, dir,
      onFrame: (n) => { if (n % 250 === 0) log.info(`  ${n} caption frames`); },
      onLongAnimation: (start) => {
        if (warnedLong) return;
        warnedLong = true;
        log.warn(`A caption animation ran longer than ${MAX_ANIMATION_SECONDS} s (from ${start.toFixed(2)} s); it is not followed further, so the picture stays as it was after ${MAX_ANIMATION_SECONDS} s until the next caption change.`);
      },
    });
    await tab.close(); // free the CPU for the encode
    log.info(`  ${new Set(entries.map((e) => e.file)).size} caption frames for ${entries.length} changes; encoding …`);
    const list = join(dir, 'captions.ffconcat');
    await writeFile(list, concatList(entries, duration, video.fps));
    await encode({
      media, list, output,
      ...(video.audioCodec ? { audioCodec: video.audioCodec } : {}),
      ...(video.videoStream ? { videoStream: video.videoStream } : {}),
    });
    return output;
  } finally {
    await tab?.close();
    await rm(dir, { recursive: true, force: true });
    forget();
  }
}
