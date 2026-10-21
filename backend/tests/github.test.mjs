import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubStore } from '../server/github-store.js';
import { initialState } from '../server/state.js';
import worker from '../server/worker.js';
function githubFixture() {
  let head = 'commit-0',
    serial = 0,
    failUpdate = false;
  const calls = [];
  const state = initialState(),
    blobs = new Map([['blob-0', Buffer.from(JSON.stringify(state))]]),
    trees = new Map([['tree-0', { 'portal-state.json': 'blob-0' }]]),
    commits = new Map([['commit-0', { tree: 'tree-0', parents: [] }]]);
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname.replace('/repos/owner/private', ''),
      body = options.body ? JSON.parse(options.body) : null,
      method = options.method || 'GET';
    calls.push({ path, method, body });
    const json = (value, status = 200) => Response.json(value, { status });
    if (path === '/git/ref/heads/main') return json({ object: { sha: head } });
    if (path.startsWith('/git/commits/') && method === 'GET')
      return json({ tree: { sha: commits.get(path.split('/').at(-1)).tree } });
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
  assert.equal(await f.store.hasFile('pdf-test'), true);
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
