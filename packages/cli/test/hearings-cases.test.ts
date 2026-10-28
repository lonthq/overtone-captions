// Regression cases for the hearings and the text vote, on the frozen hearings of real clips (test/fixtures/bench/).
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeText } from '../src/text/normalize.js';
import { FIXTURE_DIR, loadFixtures, type Fixture } from './bench/fixture.js';
import { runOvertone, type OvertoneRun } from './bench/run.js';

const fixtures = new Map<string, Fixture>(loadFixtures(FIXTURE_DIR).map((f) => [f.id, f]));
const runs = new Map<string, OvertoneRun>();
const key = (text: string) => ` ${normalizeText(text, 'en')} `;
const said = (id: string) => key(runs.get(id)!.words.map((w) => w.text).join(' '));

beforeAll(async () => {
  for (const id of ['tears-of-steel', 'libri-672-122797', 'ami-en2002a', 'cosmos-laundromat', 'nasa-ayers']) runs.set(id, await runOvertone(fixtures.get(id)!));
}, 60_000);

describe('hearings: regression cases', () => {
  it('answers every request from the fixture', () => {
    for (const [id, r] of runs) expect(r.misses, id).toEqual({ relisten: [], text: [], llm: [] });
  });

  it('Tears of Steel 6:50: "Do the ad lib." becomes "Good ad lib." (Azure, its snippet and Scribe heard "good")', () => {
    // gpt-transcribe alone wrote "I'm sorry. Do the ad lib."
    expect(said('tears-of-steel')).toContain(key("I'm sorry. Good ad lib."));
    expect(said('tears-of-steel')).not.toContain(key('Do the ad lib'));
  });

  it('Tears of Steel: "You jerked up." becomes "You\'re a jerk, Thom."', () => {
    expect(said('tears-of-steel')).toContain(key("You're a jerk, Thom. Look, Celia"));
    expect(said('tears-of-steel')).not.toContain(key('jerked up'));
  });

  it('Tears of Steel: the shouted "Move your asses!" that gpt-transcribe left out is inserted (Scribe heard it)', () => {
    expect(said('tears-of-steel')).toContain(key('Move your asses!'));
    const vote = runs.get('tears-of-steel')!.votes.find((v) => v.to === 'Move your asses!');
    expect(vote).toMatchObject({ from: '', result: 'changed' });
  });

  it('LibriSpeech: "then" stays, although Azure and Scribe agree on "and" (the snippet re-listen heard "then")', () => {
    expect(said('libri-672-122797')).toContain(key('Yes, then something better'));
    const vote = runs.get('libri-672-122797')!.votes.find((v) => v.from === 'then');
    expect(vote?.result).toMatch(/^(kept|rejected:relisten)$/);
  });

  it('Cosmos Laundromat: gpt-transcribe returned no text for the film, also when retried, so the text is ElevenLabs Scribe\'s words', () => {
    const f = fixtures.get('cosmos-laundromat')!;
    expect([f.text.raw.join(''), (f.text.retry ?? []).join('')]).toEqual(['', '']);
    const scribe = key(f.hearings.elevenlabs!.words.slice(0, 12).map((w) => w.text).join(' '));
    expect(said('cosmos-laundromat').startsWith(scribe)).toBe(true);
  });

  it('AMI EN2002a: the first answer was empty; the one retry (loudness-normalized, with the language) is the text', () => {
    const f = fixtures.get('ami-en2002a')!;
    expect(f.text.raw.join('')).toBe('');
    expect(said('ami-en2002a').startsWith(key(f.text.retry![0]!.split(' ').slice(0, 8).join(' ')))).toBe(true);
  });

  it('NASA (Ayers): the echoed --context sentence is removed and the radio call signs the engines heard put in its place', () => {
    expect(said('nasa-ayers')).not.toContain(key('explains how schools and organizations set up'));
    expect(said('nasa-ayers').startsWith(key('NA1SS, this is'))).toBe(true);
  });
});
