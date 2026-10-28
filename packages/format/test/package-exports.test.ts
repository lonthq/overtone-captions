import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// require() of this package must resolve too (CommonJS consumers, Jest, tools that resolve with require).
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
  name: string;
  exports: Record<string, string | Record<string, string>>;
};
const ENTRIES = ['.'];

describe(`${pkg.name} package exports`, () => {
  it.each(ENTRIES)('%s has "types" first, then "import" and a "default" condition', (entry) => {
    const conditions = pkg.exports[entry];
    expect(typeof conditions).toBe('object');
    const map = conditions as Record<string, string>;
    expect(Object.keys(map)).toEqual(['types', 'import', 'default']);
    expect(map.default).toBe(map.import);
  });

  // Real resolution needs the built files; the suite itself does not need a build.
  const built = ENTRIES.every((entry) => existsSync(new URL(`../${(pkg.exports[entry] as Record<string, string>).default}`, import.meta.url)));
  it.skipIf(!built).each(ENTRIES)('require.resolve finds %s', (entry) => {
    const require = createRequire(PACKAGE_JSON);
    const specifier = entry === '.' ? pkg.name : `${pkg.name}/${entry.slice(2)}`;
    const target = (pkg.exports[entry] as Record<string, string>).default;
    expect(require.resolve(specifier)).toBe(fileURLToPath(new URL(`../${target}`, import.meta.url)));
  });
});
