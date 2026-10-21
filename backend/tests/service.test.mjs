import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { localStore } from '../server/local-store.mjs';
import { createApi } from '../server/app.js';
import { passwordHash, randomToken } from '../server/auth.js';
import { removeDraftFile } from '../../website/js/domain.js';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'portal-test-')),
    store = localStore(directory);
  const salt = randomToken(),
    origin = 'https://editor.example';
  const env = {
    DB: store.DB,
    ADMIN_ORIGIN: origin,
    PUBLIC_ORIGIN: 'https://students.example',
    ADMIN_SALT: salt,
    ADMIN_PASSWORD_HASH: await passwordHash('test-only-strong-password', salt),
  };
  const api = createApi(env, store);
  let cookie = '',
    csrf = '';
  t.after(async () => {
    store.close();
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !directory.includes('portal-test-')
    )
      throw new Error('Unsafe cleanup target');
    await rm(directory, { recursive: true, force: true });
  });
  async function call(path, method = 'GET', body, auth = true, headers = {}) {
    return api(
      new Request(origin + path, {
        method,
        headers: {
          Origin: origin,
          ...(auth ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
          ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      }),
    );
  }
  async function login() {
    const response = await call(
      '/api/admin/login',
      'POST',
      { username: 'Admin', password: 'test-only-strong-password' },
      false,
    );
    assert.equal(response.status, 200);
    cookie = response.headers.get('Set-Cookie').split(';')[0];
    csrf = (await response.json()).csrf;
    return response;
  }
  return { call, login, store, env };
}
test('admin reads and writes require a server session; public data contain 35 groups and no secrets', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/admin/state')).status, 401);
  assert.equal((await f.call('/api/admin/draft', 'PUT', {})).status, 401);
  const response = await f.call('/api/public/content');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.content.groups.length, 35);
  assert.equal(JSON.stringify(body).includes(f.env.ADMIN_PASSWORD_HASH), false);
});
test('login, CSRF, origin checks, secure cookies and logout are enforced', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call('/api/admin/login', 'POST', { username: 'Admin', password: 'bad' }, false))
      .status,
    401,
  );
  assert.equal(
    (
      await f.call(
        '/api/admin/login',
        'POST',
        { username: 'Admin', password: 'test-only-strong-password' },
        false,
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  const login = await f.login();
  assert.match(login.headers.get('Set-Cookie'), /HttpOnly/);
  assert.match(login.headers.get('Set-Cookie'), /Secure/);
  assert.match(login.headers.get('Set-Cookie'), /SameSite=Strict/);
  assert.equal(
    (await f.call('/api/admin/logout', 'POST', {}, true, { 'X-CSRF-Token': 'wrong' })).status,
    403,
  );
  assert.equal((await f.call('/api/admin/logout', 'POST', {})).status, 200);
  assert.equal((await f.call('/api/admin/state')).status, 401);
});
test('sessions expire after idle and absolute deadlines; repeated logins are throttled', async (t) => {
  const f = await fixture(t);
  await f.login();
  await f.env.DB.prepare('UPDATE sessions SET touched_at = ?')
    .bind(Date.now() - 1800001)
    .run();
  assert.equal((await f.call('/api/admin/state')).status, 401);
  await f.login();
  await f.env.DB.prepare('UPDATE sessions SET created_at = ?')
    .bind(Date.now() - 28800001)
    .run();
  assert.equal((await f.call('/api/admin/state')).status, 401);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.call('/api/admin/login', 'POST', { username: 'Admin', password: 'wrong' }, false))
        .status,
      401,
    );
  assert.equal(
    (await f.call('/api/admin/login', 'POST', { username: 'Admin', password: 'wrong' }, false))
      .status,
    429,
  );
});
test('saving does not publish; stale drafts conflict; publish is atomic and idempotent; restore is draft-only', async (t) => {
  const f = await fixture(t);
  await f.login();
  let state = await (await f.call('/api/admin/state')).json();
  const oldRevision = state.revision;
  state.draft.instructions[0].body = 'New text';
  const saved = await f.call('/api/admin/draft', 'PUT', {
    revision: state.revision,
    content: state.draft,
  });
  assert.equal(saved.status, 200);
  state = (await saved.json()).state;
  assert.notEqual(
    (await (await f.call('/api/public/content')).json()).content.instructions[0].body,
    'New text',
  );
  assert.equal(
    (await f.call('/api/admin/draft', 'PUT', { revision: oldRevision, content: state.draft }))
      .status,
    409,
  );
  const operationId = crypto.randomUUID();
  let published = await f.call('/api/admin/publish', 'POST', {
    revision: state.revision,
    operationId,
  });
  assert.equal(published.status, 200);
  const result = await published.json();
  state = result.state;
  assert.equal(state.live.content.instructions[0].body, 'New text');
  published = await f.call('/api/admin/publish', 'POST', { revision: oldRevision, operationId });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).version, result.version);
  const restored = await f.call('/api/admin/restore', 'POST', {
    revision: state.revision,
    version: 'initial',
  });
  assert.equal(restored.status, 200);
  const after = (await restored.json()).state;
  assert.equal(after.live.version, state.live.version);
  assert.notEqual(after.draft.instructions[0].body, 'New text');
});
test('invalid content and missing file references cannot replace live content', async (t) => {
  const f = await fixture(t);
  await f.login();
  const state = await f.store.read();
  state.draft.instructions[0].groupId = 'missing';
  assert.equal(
    (await f.call('/api/admin/draft', 'PUT', { revision: state.revision, content: state.draft }))
      .status,
    422,
  );
  assert.equal((await (await f.call('/api/public/content')).json()).version, 'initial');
});
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj <</Type /Catalog>> endobj\n%%EOF');
test('PDF uploads validate extension, MIME, signature and size and remain private until published', async (t) => {
  const f = await fixture(t);
  await f.login();
  let state = await f.store.read();
  const form = new FormData();
  form.set('file', new File([pdf], 'קובץ.pdf', { type: 'application/pdf' }));
  form.set('revision', state.revision);
  const response = await f.call('/api/admin/upload', 'POST', form);
  assert.equal(response.status, 200);
  const upload = await response.json();
  state = upload.state;
  assert.deepEqual(upload.instruction.fileIds, [upload.file.id]);
  assert.equal(upload.instruction.body, '');
  assert.equal(upload.instruction.published, false);
  assert.equal(upload.instruction.title, 'קובץ.pdf');
  assert.equal(upload.instruction.createdAt, upload.file.createdAt);
  assert.ok(Number.isFinite(Date.parse(upload.instruction.createdAt)));
  assert.deepEqual(state.draft.instructions[0].fileIds, []);
  const path = `/api/public/files/${upload.file.id}`;
  assert.equal((await f.call(path)).status, 404);
  assert.equal((await f.call(`/api/admin/files/${upload.file.id}`)).status, 200);
  state.draft.instructions.find((item) => item.id === upload.instruction.id).published = true;
  state = (
    await (
      await f.call('/api/admin/draft', 'PUT', { revision: state.revision, content: state.draft })
    ).json()
  ).state;
  assert.equal(
    (
      await f.call('/api/admin/publish', 'POST', {
        revision: state.revision,
        operationId: crypto.randomUUID(),
      })
    ).status,
    200,
  );
  const download = await f.call(path + '?download=1');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('Content-Disposition'), /^attachment;/);
  assert.match(download.headers.get('Cache-Control'), /immutable/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), pdf);
});

test('file removal is a draft edit; publishing removes access while history can restore the PDF', async (t) => {
  const f = await fixture(t);
  await f.login();
  let state = await f.store.read();
  const uploads = [];
  for (const name of ['first.pdf', 'second.pdf']) {
    const form = new FormData();
    form.set('file', new File([pdf], name, { type: 'application/pdf' }));
    form.set('revision', state.revision);
    const response = await f.call('/api/admin/upload', 'POST', form);
    assert.equal(response.status, 200);
    const upload = await response.json();
    uploads.push(upload);
    state = upload.state;
  }
  assert.equal(state.draft.instructions.filter((item) => item.fileIds.length).length, 2);
  assert.ok(state.draft.instructions.filter((item) => item.fileIds.length).every(
    (item) => item.fileIds.length === 1 && item.body === '',
  ));
  for (const item of state.draft.instructions.filter((item) => item.fileIds.length)) {
    item.published = true;
    item.groupId = 'group-3';
  }
  const saved = await f.call('/api/admin/draft', 'PUT', { revision: state.revision, content: state.draft });
  assert.equal(saved.status, 200);
  state = (await saved.json()).state;
  const publish = async () => {
    const response = await f.call('/api/admin/publish', 'POST', {
      revision: state.revision, operationId: crypto.randomUUID(),
    });
    assert.equal(response.status, 200);
    state = (await response.json()).state;
  };
  await publish();
  const originalVersion = state.live.version;
  const removedId = uploads[0].file.id, keptId = uploads[1].file.id;
  const content = removeDraftFile(state.draft, removedId);
  assert.equal((await f.call('/api/admin/draft', 'PUT', {
    revision: state.revision, content,
  }, true, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.call('/api/admin/draft', 'PUT', { revision: 'stale', content })).status, 409);
  const deletion = await f.call('/api/admin/draft', 'PUT', { revision: state.revision, content });
  assert.equal(deletion.status, 200);
  state = (await deletion.json()).state;
  assert.equal((await f.call(`/api/admin/files/${removedId}`)).status, 404);
  assert.equal((await f.call(`/api/public/files/${removedId}`)).status, 200);
  await publish();
  assert.equal((await f.call(`/api/public/files/${removedId}`)).status, 404);
  assert.equal((await f.call(`/api/public/files/${keptId}`)).status, 200);
  assert.equal(state.live.content.instructions.filter((item) => item.fileIds.length).length, 1);
  const restored = await f.call('/api/admin/restore', 'POST', {
    revision: state.revision, version: originalVersion,
  });
  assert.equal(restored.status, 200);
  state = (await restored.json()).state;
  assert.equal((await f.call(`/api/admin/files/${removedId}`)).status, 200);
  assert.equal((await f.call(`/api/public/files/${removedId}`)).status, 404);
  await publish();
  const response = await f.call(`/api/public/files/${removedId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
});
test('fake PDF, wrong type, empty PDF and oversized PDF are rejected', async (t) => {
  const f = await fixture(t);
  await f.login();
  const state = await f.store.read();
  for (const [data, name, type] of [
    [pdf, 'bad.txt', 'application/pdf'],
    [pdf, 'bad.pdf', 'text/plain'],
    ['<html>fake</html>', 'bad.pdf', 'application/pdf'],
    ['', 'empty.pdf', 'application/pdf'],
    [new Uint8Array(5 * 1024 * 1024 + 1), 'large.pdf', 'application/pdf'],
  ]) {
    const form = new FormData();
    form.set('file', new File([data], name, { type }));
    form.set('revision', state.revision);
    assert.equal((await f.call('/api/admin/upload', 'POST', form)).status, 400);
  }
});
test('publication validates actual uploaded files and preserves live state on storage failure', async (t) => {
  const f = await fixture(t);
  await f.login();
  const state = await f.store.read();
  state.draft.files = [
    { id: 'missing-file', name: 'missing.pdf', size: 50, version: 'a'.repeat(64) },
  ];
  state.draft.instructions[0].fileIds = ['missing-file'];
  await f.store.write(state.revision, state);
  assert.equal(
    (
      await f.call('/api/admin/publish', 'POST', {
        revision: state.revision,
        operationId: crypto.randomUUID(),
      })
    ).status,
    422,
  );
  assert.equal((await f.store.read()).live.version, 'initial');
});
