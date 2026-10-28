import { spawn } from 'node:child_process';

/** Decodes a file path (first audio stream) or audio bytes to mono s16le PCM at `rate` Hz with ffmpeg. */
export function decodeToPcm(input, rate) {
  const from = typeof input === 'string' ? ['-i', input, '-map', '0:a:0'] : ['-i', 'pipe:0'];
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', ...from, '-f', 's16le', '-ac', '1', '-ar', String(rate), 'pipe:1']);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim()}`))));
    if (typeof input !== 'string') p.stdin.end(input);
  });
}
