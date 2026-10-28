// Reads single entries of a remote ZIP by range requests (central directory and needed entries only). readZip reads a
// ZIP in memory, for hosts without ranges.
import { inflateRawSync } from 'node:zlib';

// Zenodo answers 403 to requests without a User-Agent (Node's fetch sends none).
const UA = { 'User-Agent': 'overtone-bench/0.1 (benchmark fetch script)' };

async function range(url, start, end) {
  const res = await fetch(url, { headers: { ...UA, Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error(`range request failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function size(url) {
  const res = await fetch(url, { method: 'HEAD', headers: UA });
  if (!res.ok) throw new Error(`HEAD ${url}: ${res.status}`);
  return Number(res.headers.get('content-length'));
}

/** Where the central directory is, from the end of a ZIP (its last 64 KiB or less). */
function centralDirectory(tail) {
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory record (zip64 not supported)');
  return { cdSize: tail.readUInt32LE(eocd + 12), cdOffset: tail.readUInt32LE(eocd + 16) };
}

/** The entries of a central directory: [{ name, method, compSize, size, offset }]. */
function parseEntries(cd) {
  const entries = [];
  for (let p = 0; p < cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const uncSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, size: uncSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of an entry's data, decompressed. */
function inflate(entry, data) {
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/** Entries of a remote ZIP: [{ name, method, compSize, size, offset }]. */
export async function listRemoteZip(url) {
  const total = await size(url);
  const tailLen = Math.min(total, 65557);
  const { cdSize, cdOffset } = centralDirectory(await range(url, total - tailLen, total - 1));
  return parseEntries(await range(url, cdOffset, cdOffset + cdSize - 1));
}

/** Every file of a ZIP in memory: Map of entry name → decompressed bytes (folders left out). */
export function readZip(buf) {
  const { cdSize, cdOffset } = centralDirectory(buf.subarray(Math.max(0, buf.length - 65557)));
  const files = new Map();
  for (const entry of parseEntries(buf.subarray(cdOffset, cdOffset + cdSize))) {
    if (entry.name.endsWith('/')) continue;
    if (buf.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
    const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
    files.set(entry.name, inflate(entry, buf.subarray(start, start + entry.compSize)));
  }
  return files;
}

/** Downloads and decompresses one entry (from listRemoteZip). */
export async function readRemoteZipEntry(url, entry) {
  const head = await range(url, entry.offset, entry.offset + 29);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const dataStart = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (entry.compSize === 0) return Buffer.alloc(0);
  return inflate(entry, await range(url, dataStart, dataStart + entry.compSize - 1));
}
