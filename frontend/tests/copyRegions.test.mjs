import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/copyRegions.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { matchingCopyRegions } = exports;
const values = query => Array.from(matchingCopyRegions(query), region => region.value);

test('region search accepts country names, Nintendo codes and language aliases', () => {
  for (const [query, region] of [['UKV', 'United Kingdom'], ['esp', 'Spain'], [' USA ', 'United States'], ['jpn', 'Japan'], ['Japanese', 'Japan'], ['España', 'Spain']]) {
    assert.ok(values(query).includes(region), `${query} should find ${region}`);
  }
});

test('region search includes Nintendo regional groups and older PAL/NTSC editions', () => {
  const regions = values('');
  for (const region of ['Europe', 'The Americas', 'Japan', 'Australia / New Zealand', 'Hong Kong / Taiwan / South Korea', 'China', 'PAL-A', 'PAL-B', 'NTSC-U / C', 'NTSC-J']) {
    assert.ok(regions.includes(region));
  }
  assert.deepEqual(values('Spain PAL'), ['Spain']);
  assert.equal(new Set(regions).size, regions.length);
});

test('unknown regions leave room for a custom edition rather than choosing another market', () => {
  assert.deepEqual(values('Unlisted special edition'), []);
});
