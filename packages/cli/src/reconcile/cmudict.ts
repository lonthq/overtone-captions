// The CMU Pronouncing Dictionary, for the English sound check of the text vote (phonetics.ts). It is not part of the
// npm package (4.7 MB): the first English run downloads it once from a pinned URL, checks it against a pinned
// SHA-256 and keeps it in the user's cache folder. When that fails (offline, a firewall), the run goes on and English
// uses the letter-to-sound rules, like the other languages.
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Logger } from '../log.js';
import { writeFileViaTemp } from '../util/temp-file.js';

/** Where the dictionary comes from: a file at `url` with this SHA-256, kept as `file` in the cache folder. */
export interface DictionarySource { url: string; sha256: string; file: string; bytes: number }

/**
 * The npm tarball of cmu-pronouncing-dictionary 3.0.0: the CMU Pronouncing Dictionary (BSD-style license, Carnegie
 * Mellon University) as a JSON object in `package/index.js` (ISC-licensed wrapper). The same bytes as the
 * `sha512-6y5X4O…` integrity npm records for it.
 */
export const CMUDICT: DictionarySource = {
  url: 'https://registry.npmjs.org/cmu-pronouncing-dictionary/-/cmu-pronouncing-dictionary-3.0.0.tgz',
  sha256: 'ca16ac157e95277ffe1ca105a5ca2c833a15626024f15711c2a425da367b68ce',
  file: 'cmu-pronouncing-dictionary-3.0.0.tgz',
  bytes: 950_120,
};

/** How long the download may take before the run goes on without it. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The folder for files Overtone downloads once per user: OVERTONE_CACHE_HOME, else `$XDG_CACHE_HOME/overtone`, else
 * `~/.cache/overtone` (macOS and Linux) or `%LOCALAPPDATA%\overtone` (Windows). Not the per-project `.overtone/`
 * request cache, which holds transcripts.
 */
export function userCacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const own = env.OVERTONE_CACHE_HOME?.trim();
  if (own) return own;
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA?.trim() || win32.join(home, 'AppData', 'Local'), 'overtone');
  const xdg = env.XDG_CACHE_HOME?.trim();
  return posix.join(xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, '.cache'), 'overtone');
}

export interface DictionaryOptions {
  /** Read for OVERTONE_CMUDICT, OVERTONE_CACHE_HOME, XDG_CACHE_HOME and LOCALAPPDATA (default: process.env). */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: Pick<Logger, 'info' | 'warn'>;
  /** Tests pass a source of their own. */
  source?: DictionarySource;
  timeoutMs?: number;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const reason = (err: unknown) => {
  const e = err as (Error & { cause?: { code?: string; message?: string } }) | undefined;
  const cause = e?.cause?.code ?? e?.cause?.message;
  return `${e?.message ?? String(err)}${cause ? ` (${cause})` : ''}`;
};
const FALLBACK = 'English sound checks of the text vote use letter-to-sound rules instead, which are less precise';

/**
 * The dictionary (word → ARPAbet phones, alternates as "word(2)"): from OVERTONE_CMUDICT (a local copy: the npm
 * tarball, its index.js, or a cmudict.dict text file), else from the user cache folder (checked against the pinned
 * SHA-256), else downloaded now and stored there. Undefined after one warning when it cannot be had; never throws.
 */
export async function loadCmudict(opts: DictionaryOptions = {}): Promise<Map<string, string> | undefined> {
  const env = opts.env ?? process.env;
  const local = env.OVERTONE_CMUDICT?.trim();
  if (local) {
    try {
      return parseDictionary(await readFile(local));
    } catch (err) {
      opts.log?.warn(`OVERTONE_CMUDICT: cannot read ${local} as the CMU Pronouncing Dictionary (${reason(err)}); ${FALLBACK}.`);
      return undefined;
    }
  }
  const source = opts.source ?? CMUDICT;
  const dir = userCacheDir(env);
  const file = join(dir, source.file);
  try {
    const cached = await readFile(file).catch(() => undefined);
    if (cached && sha256(cached) === source.sha256) return parseDictionary(cached);
    const bytes = await download(source, file, opts);
    await storeAtomically(dir, file, bytes).catch((err: unknown) => {
      opts.log?.warn(`could not store the CMU Pronouncing Dictionary in ${dir} (${reason(err)}); it is downloaded again on the next English run. Set OVERTONE_CACHE_HOME to a writable folder.`);
    });
    return parseDictionary(bytes);
  } catch (err) {
    opts.log?.warn(`could not download the CMU Pronouncing Dictionary from ${source.url}: ${reason(err)}. ${FALLBACK}. `
      + `Download it once by hand into ${dir}, or set OVERTONE_CMUDICT to a local copy (see "CMU Pronouncing Dictionary" in the README).`);
    return undefined;
  }
}

/** The source's bytes, checked against its SHA-256. */
async function download(source: DictionarySource, file: string, opts: DictionaryOptions): Promise<Buffer> {
  opts.log?.info(`  downloading the CMU Pronouncing Dictionary (${(source.bytes / 1e6).toFixed(2)} MB, once) to ${file}`);
  const res = await (opts.fetch ?? fetch)(source.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== source.sha256) throw new Error(`its SHA-256 is ${got}, expected ${source.sha256}`);
  return bytes;
}

async function storeAtomically(dir: string, file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileViaTemp(file, bytes); // a reader never sees half a file
}

/** A dictionary file: a gzipped npm tarball, the package's index.js, or the plain cmudict text format. */
export function parseDictionary(bytes: Buffer): Map<string, string> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const index = tarEntry(gunzipSync(bytes), 'package/index.js');
    if (!index) throw new Error('no package/index.js in the tarball');
    return parseModule(index.toString('utf8'));
  }
  const text = bytes.toString('utf8');
  return text.includes(MODULE_MARK) ? parseModule(text) : parsePlain(text);
}

const MODULE_MARK = 'export const dictionary =';

/** cmu-pronouncing-dictionary's index.js: `export const dictionary = { …JSON… }`. */
function parseModule(text: string): Map<string, string> {
  const at = text.indexOf(MODULE_MARK);
  if (at < 0) throw new Error(`no "${MODULE_MARK}" in it`);
  const data = JSON.parse(text.slice(at + MODULE_MARK.length).trim().replace(/;\s*$/, '')) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the dictionary is not an object');
  const map = new Map<string, string>();
  for (const [word, phones] of Object.entries(data)) if (typeof phones === 'string') map.set(word, phones);
  if (map.size === 0) throw new Error('no entries');
  return map;
}

/** cmudict.dict ("word P H OW N Z", "# comment") or cmudict-0.7b ("WORD  P H OW N Z", ";;; comment"). */
function parsePlain(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith(';;;')) continue;
    const [entry, ...phones] = line.replace(/\s#.*$/, '').trim().split(/\s+/);
    if (!entry || phones.length === 0 || !phones.every((p) => /^[A-Z]+[0-2]?$/.test(p))) continue;
    const word = entry.toLowerCase();
    if (!map.has(word)) map.set(word, phones.join(' '));
  }
  if (map.size === 0) throw new Error('no dictionary entries found');
  return map;
}

/** The bytes of the regular file `name` in a tar archive (ustar or v7). */
function tarEntry(tar: Buffer, name: string): Buffer | undefined {
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, length: number) => header.subarray(from, from + length).toString('utf8').replace(/\0[\s\S]*$/, '');
    const prefix = field(257, 6).startsWith('ustar') ? field(345, 155) : '';
    const path = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = header[156];
    at += 512;
    if ((type === 0x30 || type === 0) && path === name) return tar.subarray(at, at + size);
    at += Math.ceil(size / 512) * 512;
  }
  return undefined;
}
