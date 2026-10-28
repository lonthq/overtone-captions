#!/usr/bin/env node
// A stand-in for whisper.cpp's `whisper-cli`, for tests. It replays recorded `-ojf` output instead of running a model.
//
// FAKE_WHISPER_SCRIPT=<file.json>: { "steps": [ { "exit": 0, "json": "<fixture path>" | { … } } | { "exit": 1, "stderr": "…" } ],
//                                     "calls": "<file>" }
// Each run takes the next step (the last one repeats), appends its argv as one JSON line to `calls`, and writes
// the step's JSON to `<-of value>.json`, as whisper-cli does with -oj/-ojf.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const scriptPath = process.env.FAKE_WHISPER_SCRIPT;
if (!scriptPath) {
  process.stderr.write('fake whisper-cli: FAKE_WHISPER_SCRIPT is not set\n');
  process.exit(2);
}
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const n = script.next ?? 0;
script.next = n + 1;
writeFileSync(scriptPath, JSON.stringify(script));
const args = process.argv.slice(2);
if (script.calls) appendFileSync(script.calls, `${JSON.stringify(args)}\n`);

const step = script.steps[Math.min(n, script.steps.length - 1)];
if (step.exit !== 0) {
  process.stderr.write(step.stderr ?? 'error\n');
  process.exit(step.exit);
}
const of = args[args.indexOf('-of') + 1];
const json = typeof step.json === 'string' ? readFileSync(step.json, 'utf8') : JSON.stringify(step.json);
if (args.includes('-oj') && of) writeFileSync(`${of}.json`, json);
process.stdout.write('[00:00:00.000 --> 00:00:01.000]   (results on stdout are ignored)\n');
