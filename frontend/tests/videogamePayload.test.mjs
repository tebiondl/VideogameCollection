import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/videogamePayload.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { collectionGameUpdatePayload } = exports;

test('collection edits preserve old-copy console, hours and identity', () => {
  const oldCopies = JSON.stringify([
    { id: 'old-copy-1', console: 'Nintendo Switch', playtime_hours: 42.5 },
  ]);
  const payload = collectionGameUpdatePayload({
    name: 'Game', status: 'Finished', copies: null, old_copies: oldCopies, version: 3,
  });
  assert.equal(payload.old_copies, oldCopies);
  assert.deepEqual(JSON.parse(payload.old_copies), [
    { id: 'old-copy-1', console: 'Nintendo Switch', playtime_hours: 42.5 },
  ]);
});

test('removing every old copy sends null so persisted history is cleared', () => {
  const payload = collectionGameUpdatePayload({ name: 'Game', old_copies: null });
  assert.equal(payload.old_copies, null);
});
