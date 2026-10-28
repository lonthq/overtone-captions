#!/usr/bin/env node
// Freezes the regression gate's fixtures from saved runs on this machine (see bench/lib/gate-freeze.ts).
// No API calls; needs ffmpeg.
//
//   node bench/gate-freeze.mjs [clip ...]     all clips, or only the ones named
import { loadTs } from './lib/load-ts.mjs';

const { main } = await loadTs('bench/lib/gate-freeze.ts');
await main(process.argv.slice(2));
