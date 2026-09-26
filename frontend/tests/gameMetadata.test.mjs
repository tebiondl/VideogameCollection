import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/gameMetadata.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
vm.runInNewContext(code, { exports });
const { applyGameMetadata } = exports;

test('lookup replaces game data while keeping personal progress and copies', () => {
  const draft = { name: 'Portal 2', description: 'Old', status: 'Finished', comments: 'My review',
    tags: 'favorite', copies: '[{"id":"copy-1"}]', playtime_hours: 20, igdb_id: 8 };
  const result = applyGameMetadata(draft, { source: 'IGDB', name: 'Portal 2', description: 'New',
    image_url: 'cover', publication_year: 2011, release_date: '2011-04-19', is_dlc: false,
    parent_game_name: null, igdb_id: 42 });
  assert.equal(result.description, 'New');
  assert.equal(result.igdb_id, 42);
  for (const field of ['status', 'comments', 'tags', 'copies', 'playtime_hours']) {
    assert.equal(result[field], draft[field]);
  }
});

test('missing Steam fields keep existing data and external identity', () => {
  const result = applyGameMetadata({ name: 'Game', description: 'Keep', image_url: 'existing', igdb_id: 10 },
    { source: 'Steam', name: 'Game', description: null, image_url: null, publication_year: null,
      release_date: null, is_dlc: false, parent_game_name: null });
  assert.equal(result.description, 'Keep');
  assert.equal(result.image_url, 'existing');
  assert.equal(result.igdb_id, 10);
});
