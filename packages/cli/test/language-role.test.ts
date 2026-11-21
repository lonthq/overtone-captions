import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachedLanguage, RequestCache } from '../src/cache.js';
import { implementsRole } from '../src/providers/kit.js';
import { createProvider, registerProvider, resolveSelection } from '../src/providers/registry.js';
import type { LanguageProvider } from '../src/providers/types.js';
import { UsageMeter } from '../src/usage.js';
import { tempDir } from './tmp.js';

describe('the language role', () => {
  it('is implemented by a provider with detect()', () => {
    expect(implementsRole({ detect: async () => ({ words: {} }) }, 'language')).toBe(true);
    expect(implementsRole({ align: async () => ({ words: [] }) }, 'language')).toBe(false);
  });

  it('caches detect() by audio', async () => {
    const dir = await tempDir('overtone-langrole-');
    const wav = join(dir, 'a.wav');
    await writeFile(wav, 'RIFF fake'); // created by the test, never committed
    let calls = 0;
    const p: LanguageProvider = { id: 'fake:lang', detect: async () => { calls++; return { words: { nl: 12 } }; } };
    const c = cachedLanguage(p, new RequestCache(dir, { useCache: true }), 'extract');
    expect(await c.detect({ path: wav, duration: 30 })).toEqual({ words: { nl: 12 } });
    expect(await c.detect({ path: wav, duration: 30 })).toEqual({ words: { nl: 12 } });
    expect(calls).toBe(1);
  });

  it('lists language usage first', () => {
    const m = new UsageMeter();
    m.add({ id: 'b', role: 'text', audioSeconds: 1 });
    m.add({ id: 'a', role: 'language', audioSeconds: 30 });
    expect(m.list().map((t) => t.role)).toEqual(['language', 'text']);
  });

  it('resolves and creates a registered language provider, with redacted errors', async () => {
    const secret = 'secret-value-0123456789';
    const unregister = registerProvider({
      id: 'test-lang', description: 'test', roles: ['language'],
      env: [{ name: 'TEST_LANG_KEY', description: 'key', required: true, secret: true }],
      defaults: { language: 'm1' },
      create: () => ({ id: 'test-lang:m1', detect: async () => { throw new Error(`denied for ${secret}`); } }) as LanguageProvider,
    });
    try {
      const sel = resolveSelection({ provider: 'test-lang', id: 'test-lang' }, 'language');
      expect(sel.id).toBe('test-lang:m1');
      const p = createProvider('language', sel, { TEST_LANG_KEY: secret }, { cwd: '/' }) as LanguageProvider;
      const err = (await p.detect({ path: '/x.wav', duration: 1 }).catch((e: unknown) => e)) as Error;
      expect(err.message).not.toContain(secret);
    } finally {
      unregister();
    }
  });
});
