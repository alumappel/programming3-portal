import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubStore } from '../server/github-store.js';
import { initialState } from '../server/state.js';
import { createApi } from '../server/app.js';
import { sha256 } from '../server/auth.js';
import { publicContent } from '../../website/js/domain.js';
import worker from '../server/worker.js';
function githubFixture({ state = initialState(), maxRequests = Infinity, missing = [], truncated = false } = {}) {
  let head = 'commit-0',
    serial = 0,
    failUpdate = false;
  const calls = [];
  const blobs = new Map([['blob-0', Buffer.from(JSON.stringify(state))]]),
    trees = new Map([['tree-0', { 'portal-state.json': 'blob-0' }]]),
    commits = new Map([['commit-0', { tree: 'tree-0', parents: [] }]]);
  for (const file of state.draft.files) {
    if (missing.includes(file.id)) continue;
    const sha = `blob-${file.id}`;
    blobs.set(sha, Buffer.from('%PDF-1.7 test %%EOF'));
    trees.get('tree-0')[`files/${file.id}.pdf`] = sha;
  }
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname.replace('/repos/owner/private', ''),
      body = options.body ? JSON.parse(options.body) : null,
      method = options.method || 'GET';
    calls.push({ path, method, body });
    if (calls.length > maxRequests) throw new Error('Too many subrequests.');
    const json = (value, status = 200) => Response.json(value, { status });
    if (path === '/git/ref/heads/main') return json({ object: { sha: head } });
    if (path.startsWith('/git/commits/') && method === 'GET')
      return json({ tree: { sha: commits.get(path.split('/').at(-1)).tree } });
    if (path.startsWith('/git/trees/') && method === 'GET') {
      assert.equal(new URL(url).searchParams.get('recursive'), '1');
      const ref = path.split('/').at(-1),
        tree = trees.get(ref) || trees.get(commits.get(ref === 'main' ? head : ref)?.tree);
      return json({
        tree: Object.entries(tree).map(([path, sha]) => ({ path, sha, type: 'blob', mode: '100644' })),
        truncated,
      });
    }
    if (path.startsWith('/contents/')) {
      const ref = new URL(url).searchParams.get('ref'),
        commit = commits.get(ref === 'main' ? head : ref),
        filePath = path.slice('/contents/'.length),
        sha = trees.get(commit.tree)[filePath];
      return sha ? json({ sha, content: blobs.get(sha).toString('base64') }) : json({}, 404);
    }
    if (path === '/git/blobs' && method === 'POST') {
      const sha = `blob-${++serial}`;
      blobs.set(sha, Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8'));
      return json({ sha });
    }
    if (path.startsWith('/git/blobs/') && method === 'GET')
      return json({ content: blobs.get(path.split('/').at(-1)).toString('base64') });
    if (path === '/git/trees') {
      const sha = `tree-${++serial}`,
        tree = { ...trees.get(body.base_tree) };
      for (const item of body.tree) tree[item.path] = item.sha;
      trees.set(sha, tree);
      return json({ sha });
    }
    if (path === '/git/commits') {
      const sha = `commit-${++serial}`;
      commits.set(sha, { tree: body.tree, parents: body.parents });
      return json({ sha });
    }
    if (path === '/git/refs/heads/main') {
      if (failUpdate || commits.get(body.sha).parents[0] !== head) return json({}, 422);
      head = body.sha;
      return json({ object: { sha: head } });
    }
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  };
  const env = {
    GITHUB_REPOSITORY: 'owner/private',
    GITHUB_BRANCH: 'main',
    GITHUB_TOKEN: 'fake-test-token',
  };
  return {
    store: githubStore(env, fetcher),
    calls,
    state,
    env,
    fail: () => {
      failUpdate = true;
    },
  };
}
async function publishFixture(newFiles, options = {}) {
  const state = initialState();
  for (let i = 0; i < 65; i++) {
    const id = `pdf-${i}`;
    state.draft.files.push({ id, name: `${i}.pdf`, size: 19, version: 'a'.repeat(64) });
    state.draft.instructions.push({
      id: `instruction-${id}`, title: `${i}.pdf`, body: '', fileIds: [id],
      stageId: null, groupId: `group-${i % 35 + 1}`, order: i + 2, published: i < 34,
    });
  }
  state.live.content = publicContent(state.draft);
  for (let i = 34; i < 34 + newFiles; i++) state.draft.instructions[i + 1].published = true;
  const f = githubFixture({ state, maxRequests: 50, ...options }),
    origin = 'https://editor.example',
    token = 'a'.repeat(64),
    csrf = 'test-csrf',
    tokenHash = await sha256(token);
  const env = {
    ...f.env, ADMIN_ORIGIN: origin,
    DB: {
      prepare(sql) {
        let values;
        return {
          bind(...args) { values = args; return this; },
          async first() {
            assert.equal(sql, 'SELECT * FROM sessions WHERE token_hash = ?');
            assert.equal(values[0], tokenHash);
            return { csrf, created_at: Date.now(), touched_at: Date.now() };
          },
          async run() { assert.match(sql, /^UPDATE sessions SET touched_at/); },
        };
      },
    },
  };
  const api = createApi(env, f.store);
  return {
    ...f,
    publish: async (operationId) => {
      f.calls.length = 0;
      return api(new Request(origin + '/api/admin/publish', {
        method: 'POST',
        headers: { Origin: origin, Cookie: `portal_session=${token}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: state.revision, operationId }),
      }));
    },
  };
}

for (const newFiles of [10, 31]) {
  test(`publishing 34 existing PDFs plus ${newFiles} new PDFs stays below 50 GitHub requests`, async () => {
    const f = await publishFixture(newFiles),
      operationId = crypto.randomUUID(),
      response = await f.publish(operationId),
      result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.equal(result.state.live.content.files.length, 34 + newFiles);
    assert.deepEqual(result.state.draft, f.state.draft);
    assert.deepEqual(result.state.history[0], f.state.live);
    assert.ok(f.calls.length <= 12, `${f.calls.length} GitHub requests`);
    assert.equal(f.calls.filter((call) => call.path.startsWith('/git/trees/') && call.method === 'GET').length, 1);
    assert.equal(f.calls.some((call) => call.path.startsWith('/contents/files/')), false);
    const repeated = await f.publish(operationId),
      again = await repeated.json();
    assert.equal(repeated.status, 200);
    assert.equal(again.version, result.version);
    assert.equal(again.state.history.length, 1);
    assert.equal(f.calls.some((call) => call.method !== 'GET'), false);
  });
}

test('a missing PDF blocks GitHub publication without changing the draft or live content', async () => {
  const f = await publishFixture(31, { missing: ['pdf-64'] }),
    response = await f.publish(crypto.randomUUID()),
    result = await response.json();
  assert.equal(response.status, 422, result.error);
  assert.match(result.error, /64\.pdf/);
  assert.equal(f.calls.some((call) => call.method !== 'GET'), false);
  assert.deepEqual(await f.store.read(true), f.state);
});

test('a truncated GitHub file listing blocks publication without changing stored content', async () => {
  const f = await publishFixture(31, { truncated: true }),
    response = await f.publish(crypto.randomUUID());
  assert.equal(response.status, 503);
  assert.equal(f.calls.some((call) => call.method !== 'GET'), false);
  assert.deepEqual(await f.store.read(true), f.state);
});

test('GitHub adapter caches only a short-lived copy and commits state via a non-forced ref update', async () => {
  const f = githubFixture(),
    before = await f.store.read();
  before.draft.activity.title = 'Local mutation';
  assert.notEqual((await f.store.read()).draft.activity.title, 'Local mutation');
  const next = structuredClone(f.state);
  next.revision = crypto.randomUUID();
  next.draft.activity.title = 'Published revision';
  await f.store.write(f.state.revision, next);
  assert.equal((await f.store.read(true)).draft.activity.title, 'Published revision');
  const update = f.calls.find((x) => x.path === '/git/refs/heads/main');
  assert.equal(update.body.force, false);
  await assert.rejects(
    () => f.store.write(f.state.revision, { ...next, revision: crypto.randomUUID() }),
    (error) => error.status === 409,
  );
});
test('a GitHub ref race leaves the previously published revision intact', async () => {
  const f = githubFixture();
  f.fail();
  await assert.rejects(
    () => f.store.write(f.state.revision, { ...f.state, revision: crypto.randomUUID() }),
    (error) => error.status === 409,
  );
  assert.equal((await f.store.read(true)).revision, f.state.revision);
});
test('GitHub PDF upload creates a versioned file without changing state, and retrieves identical bytes', async () => {
  const f = githubFixture(),
    bytes = new TextEncoder().encode('%PDF-1.7 test %%EOF');
  await f.store.putFile('pdf-test', bytes);
  assert.deepEqual(await f.store.missingFiles(['pdf-test', 'pdf-absent']), ['pdf-absent']);
  assert.deepEqual(await f.store.getFile('pdf-test'), bytes);
  assert.equal((await f.store.read(true)).revision, f.state.revision);
});
test('Worker serves the editable HTML and assets directly with no stale cache and secure headers', async () => {
  const urls = [],
    env = {
      ASSETS: {
        fetch: async (request) => {
          urls.push(new URL(request.url).pathname);
          return new Response('<html>Editor</html>', { headers: { 'Content-Type': 'text/html' } });
        },
      },
    };
  const redirect = await worker.fetch(new Request('https://worker.example/'), env);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('Location'), 'https://worker.example/admin.html');
  const page = await worker.fetch(new Request('https://worker.example/admin.html'), env);
  assert.deepEqual(urls, ['/admin.html']);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const asset = await worker.fetch(
    new Request('https://worker.example/js/admin.js?v=manual-1'),
    env,
  );
  assert.equal(urls.at(-1), '/js/admin.js');
  assert.equal(asset.headers.get('Cache-Control'), 'no-store');
});
