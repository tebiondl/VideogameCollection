import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/steamDlcs.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { addManualDlc, mergeSteamDlcs } = exports;

test('Steam DLC merge adds new entries as unowned and preserves existing ownership states', () => {
  const existing = [
    { name: 'Granblue Fantasy: Relink - Color Pack', state: 'finished', steam_appid: 101 },
    { name: 'Other Bonus DLC', state: 'playing' },
  ];
  const catalog = [
    { name: 'Granblue Fantasy: Relink - Color Pack', state: 'not_owned', steam_appid: 101 },
    { name: 'Other Bonus DLC', state: 'not_owned', steam_appid: 102 },
    { name: 'Endless Ragnarok Upgrade Kit', state: 'not_owned', steam_appid: 103 },
  ];
  const result = mergeSteamDlcs(existing, catalog);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 2);
  assert.deepEqual(Array.from(result.dlcs, item => item.state), ['finished', 'playing', 'not_owned']);
  assert.equal(result.dlcs[1].steam_appid, 102);
  assert.equal(existing[1].steam_appid, undefined);
  assert.equal(mergeSteamDlcs(result.dlcs, catalog).added, 0);
});

test('a close manual DLC name links to one Steam entry without losing progress', () => {
  const existing = [
    { name: 'Endless Ragnarok Upgrade Kit', state: 'finished', source: 'Manual' },
    { name: 'My custom bonus', state: 'not_owned', source: 'Manual' },
  ];
  const catalog = [{
    name: 'Granblue Fantasy: Relink - Endless Ragnarok Upgrade Kit', state: 'not_owned',
    steam_appid: 4306890, steam_parent_appid: 881020, source: 'Steam catalog',
  }];
  const result = mergeSteamDlcs(existing, catalog, 'Grandblue Fantasy Relink');
  assert.equal(result.added, 0);
  assert.equal(result.dlcs.length, 2);
  assert.equal(result.dlcs[0].steam_appid, 4306890);
  assert.equal(result.dlcs[0].state, 'finished');
  assert.equal(result.dlcs[0].source, 'Steam catalog');
  assert.equal(result.dlcs[1].source, 'Manual');
});

test('typed names reuse an existing Steam DLC but keep numbered packs separate', () => {
  const steam = [{ name: 'Granblue Fantasy: Relink - Color Pack 1', state: 'not_owned', steam_appid: 101 }];
  const same = addManualDlc(steam, 'Grandblue Fantasy Relink - Color Pack 1', 'Grandblue Fantasy Relink');
  assert.equal(same.linked, true);
  assert.equal(same.dlcs.length, 1);
  const different = addManualDlc(steam, 'Granblue Fantasy: Relink - Color Pack 2', 'Grandblue Fantasy Relink');
  assert.equal(different.linked, false);
  assert.equal(different.dlcs.length, 2);
  assert.equal(different.dlcs[1].source, 'Manual');
});

test('refresh collapses duplicate Steam IDs while keeping the more advanced state', () => {
  const result = mergeSteamDlcs([
    { name: 'Expansion', state: 'not_owned', steam_appid: 101 },
    { name: 'Expansion', state: 'finished', steam_appid: 101 },
  ], [{ name: 'Expansion', state: 'not_owned', steam_appid: 101 }]);
  assert.equal(result.dlcs.length, 1);
  assert.equal(result.dlcs[0].state, 'finished');
});
