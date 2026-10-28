#!/usr/bin/env node
// Download the media of the caption readability benchmark (see README.md and clips.json).
//
//   node bench/captions/fetch.mjs                     fetch every clip (skips clips that are already there)
//   node bench/captions/fetch.mjs --force             fetch again even if the files exist
//   node bench/captions/fetch.mjs --update-checksums  record new checksums instead of failing on a mismatch
//
// Output per clip, in bench/captions/data/<clip>/ (git-ignored; never commit media):
//   audio.wav      16 kHz mono 16-bit PCM WAV, the exact audio every system gets
// The downloaded media goes to its own empty folder (data/<clip>/download/) and is deleted after the audio is
// extracted. The SHA-256 checksum of each audio.wav is kept in checksums.json (committed).
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { decodeToPcm } from '../lib/pcm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const CHECKSUMS = join(HERE, 'checksums.json');
const RATE = 16000;
const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const UPDATE = args.has('--update-checksums');

const { clips } = JSON.parse(readFileSync(join(HERE, 'clips.json'), 'utf8'));
const checksums = existsSync(CHECKSUMS) ? JSON.parse(readFileSync(CHECKSUMS, 'utf8')) : {};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
let downloaded = 0;

/** Stream a URL to a file (3 attempts). */
async function download(url, path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
      downloaded += readFileSync(path).length;
      return;
    } catch (err) {
      if (attempt >= 3) throw new Error(`GET ${url} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** A plain 44-byte WAV header + PCM (no metadata, so the bytes are reproducible). */
function wavFromPcm(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function verify(id, name, buf) {
  const sum = sha256(buf);
  checksums[id] ??= {};
  const known = checksums[id][name];
  if (known && known !== sum && !UPDATE) throw new Error(`CHECKSUM MISMATCH for ${id}/${name}: expected ${known}, got ${sum} (rerun with --update-checksums if the source changed on purpose)`);
  if (!known || UPDATE) checksums[id][name] = sum;
}

let failed = false;
for (const clip of clips) {
  const dir = join(DATA, clip.id);
  const audio = join(dir, 'audio.wav');
  if (!FORCE && existsSync(audio)) {
    try {
      verify(clip.id, 'audio.wav', readFileSync(audio));
      console.error(`${clip.id}: present, checksum ok`);
    } catch (err) { console.error(`error: ${err.message}`); failed = true; }
    continue;
  }
  try {
    mkdirSync(dir, { recursive: true });
    const dl = join(dir, 'download');
    rmSync(dl, { recursive: true, force: true });
    mkdirSync(dl);
    console.error(`${clip.id}: downloading media (${clip.media.url.split('/').pop()})`);
    const ext = clip.media.url.split('.').pop();
    const media = join(dl, `media.${ext}`);
    await download(clip.media.url, media);
    const wav = wavFromPcm(await decodeToPcm(media, RATE));
    verify(clip.id, 'audio.wav', wav);
    writeFileSync(audio, wav);
    rmSync(dl, { recursive: true, force: true });
    console.error(`${clip.id}: audio.wav ${((wav.length - 44) / 2 / RATE).toFixed(1)} s`);
  } catch (err) {
    console.error(`error: ${clip.id}: ${err.message}`);
    failed = true;
  }
}
writeFileSync(CHECKSUMS, `${JSON.stringify(checksums, null, 2)}\n`);
console.error(`downloaded ${(downloaded / 1e6).toFixed(1)} MB`);
if (failed) process.exit(1);
