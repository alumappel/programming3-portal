import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localStore } from '../server/local-store.mjs';
import { localSetup } from '../server/local-setup.mjs';
import { passwordHash } from '../server/auth.js';
import { exportPublished } from '../server/static-export.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'portal-editor-'));
  const store = localStore(directory);
  const env = { DB: store.DB, ADMIN_ORIGIN: 'http://127.0.0.1:4173', LOCAL_DEV: true };
  t.after(async () => {
    store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('portal-editor-')) throw new Error('Unsafe cleanup path');
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, env };
}
const request = (password, origin = 'http://127.0.0.1:4173') => new Request('http://127.0.0.1:4173/api/local/setup', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
});

test('local password setup stores only a hash, survives restart and cannot overwrite an existing password', async t => {
  const { store, env } = await fixture(t);
  const setup = await localSetup(env);
  assert.deepEqual(await (await setup(new Request('http://127.0.0.1:4173/api/local/setup'))).json(), { needsSetup: true });
  assert.equal((await setup(request('editor-password-test-123'))).status, 201);
  const savedHash = env.ADMIN_PASSWORD_HASH;
  const record = await store.DB.prepare('SELECT value FROM local_settings WHERE key = ?').bind('admin_credentials').first();
  assert.ok(!record.value.includes('editor-password-test-123'));
  const restarted = { DB: store.DB, ADMIN_ORIGIN: env.ADMIN_ORIGIN, LOCAL_DEV: true };
  const afterRestart = await localSetup(restarted);
  assert.equal(restarted.ADMIN_PASSWORD_HASH, savedHash);
  assert.equal(await passwordHash('editor-password-test-123', restarted.ADMIN_SALT), savedHash);
  assert.equal((await afterRestart(request('different-password-123'))).status, 409);
  assert.equal(restarted.ADMIN_PASSWORD_HASH, savedHash);
});

test('setup rejects foreign origins and short passwords, and is disabled outside local development', async t => {
  const { env } = await fixture(t);
  const setup = await localSetup(env);
  assert.equal((await setup(request('valid-password-123', 'https://other.example'))).status, 403);
  assert.equal((await setup(request('short'))).status, 422);
  env.LOCAL_DEV = false;
  assert.equal((await setup(request('valid-password-123'))).status, 404);
  assert.equal(env.ADMIN_PASSWORD_HASH, undefined);
});

test('parallel setup requests can initialize only one password', async t => {
  const { env } = await fixture(t);
  const setup = await localSetup(env);
  const responses = await Promise.all([setup(request('first-password-123')), setup(request('second-password-123'))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  const winner = responses[0].status === 201 ? 'first-password-123' : 'second-password-123';
  assert.equal(await passwordHash(winner, env.ADMIN_SALT), env.ADMIN_PASSWORD_HASH);
});

test('public export mirrors only the live version, including PDF bytes, without leaking draft edits', async t => {
  const { directory, store } = await fixture(t);
  const state = await store.read();
  state.draft.instructions[0].body = 'Private unsaved course text';
  state.live.content.files = [{ id: 'pdf-published', name: 'public.pdf', size: 20, version: 'a'.repeat(64) }];
  const bytes = new TextEncoder().encode('%PDF-1.7 public %%EOF');
  await store.putFile('pdf-published', bytes);
  await store.write(state.revision, state);
  const destination = pathToFileURL(directory + sep);
  assert.equal(await exportPublished(store, destination), state.live.version);
  const result = JSON.parse(await readFile(new URL('content.json', destination), 'utf8'));
  assert.equal(result.content.groups.length, 35);
  assert.ok(!JSON.stringify(result).includes('Private unsaved course text'));
  assert.deepEqual(new Uint8Array(await readFile(new URL('files/pdf-published.pdf', destination))), bytes);
});

test('an export with a missing PDF preserves the last static content file', async t => {
  const { directory, store } = await fixture(t);
  const destination = pathToFileURL(directory + sep);
  await writeFile(new URL('content.json', destination), 'previous-content');
  const state = await store.read();
  state.live.content.files = [{ id: 'missing', name: 'missing.pdf' }];
  await store.write(state.revision, state);
  await assert.rejects(() => exportPublished(store, destination));
  assert.equal(await readFile(new URL('content.json', destination), 'utf8'), 'previous-content');
});
