import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/lib/saveCollectionGame.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadSave(fetchWithAuth) {
  const exports = {};
  vm.runInNewContext(code, { exports, require: () => ({ fetchWithAuth }) });
  return exports.saveCollectionGame;
}

test('saving as new posts the selected game directly, preserving all personal fields', async () => {
  const game = { name: 'Xenoblade Chronicles', play_next: true, playtime_mode: 'copies', copies: null };
  const requests = [];
  const save = loadSave(async (url, options) => {
    requests.push({ url, options });
    return new Response('{}', { status: 200 });
  });
  await save(game);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/videogames/');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), game);
});

test('server rejection is visible and the same draft can be retried successfully', async () => {
  let attempts = 0;
  const save = loadSave(async () => ++attempts === 1
    ? new Response(JSON.stringify({ detail: 'Could not save this game. Try again.' }), { status: 500 })
    : new Response('{}', { status: 200 }));
  const game = { name: 'Xenoblade Chronicles' };
  await assert.rejects(save(game), /Could not save this game\. Try again\./);
  await save(game);
  assert.equal(attempts, 2);
});

test('validation errors include readable field names instead of object strings', async () => {
  const save = loadSave(async () => new Response(JSON.stringify({ detail: [
    { loc: ['body', 'copies'], msg: 'Every copy needs a unique ID' },
    { loc: ['body', 'playtime_mode'], msg: 'Invalid time mode' },
  ] }), { status: 422 }));
  await assert.rejects(save({ name: 'Game' }), /copies: Every copy needs a unique ID; playtime_mode: Invalid time mode/);
});

test('network failures and non-JSON responses provide actionable errors', async () => {
  const networkSave = loadSave(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(networkSave({ name: 'Game' }), /Could not reach the server/);
  const proxySave = loadSave(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(proxySave({ name: 'Game' }), /HTTP 502/);
  const emptySave = loadSave(async () => new Response('null', { status: 500 }));
  await assert.rejects(emptySave({ name: 'Game' }), /HTTP 500/);
});
