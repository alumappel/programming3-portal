import { HttpError, conflict } from './state.js';
const encode = (bytes) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
const decode = (value) => Uint8Array.from(atob(value.replace(/\s/g, '')), (c) => c.charCodeAt(0));
export function githubStore(env, fetcher = fetch) {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') ||
    !env.GITHUB_TOKEN ||
    !env.GITHUB_BRANCH
  )
    throw new HttpError(503, 'חיבור מאגר התוכן טרם הוגדר בשרת.');
  const root = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  const branch = env.GITHUB_BRANCH.split('/').map(encodeURIComponent).join('/');
  let cached = null,
    expires = 0;
  async function call(path, method = 'GET', body) {
    const response = await fetcher(root + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'group-learning-portal',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      if (response.status === 409 || response.status === 422) throw conflict();
      if (
        response.status === 429 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
      )
        throw new HttpError(
          503,
          'מכסת GitHub הושגה. המתינו לפני ניסיון נוסף. הגרסה החיה לא נדרסה.',
        );
      throw new HttpError(
        503,
        response.status === 404
          ? 'מאגר התוכן או קובץ האתחול חסרים. בדקו את החיבור ואת הרשאות המאגר הפרטי.'
          : 'החיבור ל־GitHub נכשל. בדקו את המפתח, ההרשאות ותוקפו.',
      );
    }
    return response.json();
  }
  async function head() {
    const ref = await call(`/git/ref/heads/${branch}`);
    const commit = await call(`/git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, tree: commit.tree.sha };
  }
  async function readAt(sha) {
    const file = await call(`/contents/portal-state.json?ref=${sha}`);
    if (!file.content)
      throw new HttpError(503, 'קובץ התוכן גדול מדי לקריאה. יש לשחזר גיבוי קטן יותר.');
    return JSON.parse(new TextDecoder().decode(decode(file.content)));
  }
  async function commitFile(snapshot, path, blobSha, message) {
    const tree = await call('/git/trees', 'POST', {
      base_tree: snapshot.tree,
      tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }],
    });
    const commit = await call('/git/commits', 'POST', {
      message,
      tree: tree.sha,
      parents: [snapshot.sha],
    });
    // Fast-forward only: parallel commits cannot silently overwrite one another.
    await call(`/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false });
    cached = null;
    expires = 0;
  }
  return {
    kind: 'github',
    async read(fresh = false) {
      if (!fresh && cached && Date.now() < expires) return structuredClone(cached);
      const snapshot = await head(),
        state = await readAt(snapshot.sha);
      cached = state;
      expires = Date.now() + 20000;
      return structuredClone(state);
    },
    async write(revision, state) {
      const snapshot = await head(),
        current = await readAt(snapshot.sha);
      if (current.revision !== revision) throw conflict();
      const blob = await call('/git/blobs', 'POST', {
        content: JSON.stringify(state),
        encoding: 'utf-8',
      });
      await commitFile(snapshot, 'portal-state.json', blob.sha, `Portal update ${state.revision}`);
      cached = state;
      expires = Date.now() + 20000;
    },
    async putFile(id, bytes) {
      const snapshot = await head(),
        blob = await call('/git/blobs', 'POST', { content: encode(bytes), encoding: 'base64' });
      await commitFile(snapshot, `files/${id}.pdf`, blob.sha, `Upload PDF ${id}`);
    },
    async getFile(id) {
      const meta = await call(
        `/contents/files/${id}.pdf?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`,
      );
      const blob = await call(`/git/blobs/${meta.sha}`);
      return decode(blob.content);
    },
    async hasFile(id) {
      await call(`/contents/files/${id}.pdf?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
      return true;
    },
  };
}
