import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/copyCompatibility.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { compatibleCopyFormat, compatibleCopyFormats, compatibleCopySources, isCopySourceCompatible } = exports;

const sources = ['Steam', 'Nintendo eShop', 'PlayStation Store', 'Xbox Store', 'Retail', 'Gift', 'Subscription', 'Other'];

test('Nintendo Switch only offers its store, retail and other', () => {
  assert.deepEqual(
    [...compatibleCopySources('Nintendo Switch', sources)],
    ['Nintendo eShop', 'Retail', 'Other'],
  );
  assert.equal(isCopySourceCompatible('Nintendo Switch 2', 'Steam'), false);
});

test('console stores stay with their platform families', () => {
  assert.deepEqual(
    [...compatibleCopySources('PlayStation 5', sources)],
    ['PlayStation Store', 'Retail', 'Gift', 'Subscription', 'Other'],
  );
  assert.deepEqual(
    [...compatibleCopySources('Xbox Series X|S', sources)],
    ['Xbox Store', 'Retail', 'Gift', 'Subscription', 'Other'],
  );
});

test('retail is physical while Steam and digital stores are digital', () => {
  assert.deepEqual([...compatibleCopyFormats('PC', 'Steam')], ['Digital']);
  assert.deepEqual([...compatibleCopyFormats('Nintendo Switch', 'Nintendo eShop')], ['Digital']);
  assert.deepEqual([...compatibleCopyFormats('PlayStation 5', 'Retail')], ['Physical']);
  assert.equal(compatibleCopyFormat('PC', 'Steam', 'Physical'), 'Digital');
});

test('Steam Deck cannot be physical', () => {
  assert.deepEqual([...compatibleCopyFormats('Steam Deck', 'Other')], ['Digital']);
  assert.equal(isCopySourceCompatible('Steam Deck', 'Retail'), false);
});
