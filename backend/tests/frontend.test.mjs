import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateContent } from '../../website/js/domain.js';

const site = new URL('../../website/', import.meta.url);

test('editable HTML, CSS and native JS imports resolve directly without a build step', async () => {
  for (const name of ['index.html', 'admin.html']) {
    const html = await readFile(new URL(name, site), 'utf8');
    assert.match(html, /<html lang="he" dir="rtl">/);
    assert.doesNotMatch(html, /__(?:STYLES|SCRIPT|BUDDIES_URL|API_BASE)__|dist\/|src\/client/);
    for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (/^(https?:|\/)/.test(match[1])) continue;
      await access(fileURLToPath(new URL(match[1], site)));
    }
  }
  for (const name of await readdir(new URL('js/', site))) {
    const path = new URL(`js/${name}`, site);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      await access(fileURLToPath(new URL(match[1], path)));
    }
  }
  for (const name of ['style.css', 'admin.css']) {
    const path = new URL(`css/${name}`, site);
    const css = await readFile(path, 'utf8');
    for (const match of css.matchAll(/url\(['"]([^'"]+)['"]\)/g)) {
      await access(fileURLToPath(new URL(match[1], path)));
    }
  }
});

test('Live Server defaults to a local public JSON file and loads all 35 groups without an API', async (t) => {
  const { settings, USE_API } = await import('../../website/js/config.js');
  assert.equal(settings.readFromApi, false);
  assert.equal(USE_API, false);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(await readFile(new URL(url)), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const { loadContent } = await import('../../website/js/helpers.js');
  const result = await loadContent();
  assert.equal(result.content.groups.length, 35);
  assert.deepEqual(validateContent(result.content), []);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /website\/data\/content\.json$/);
  assert.equal(requests[0].options.cache, 'no-store');
  assert.doesNotMatch(requests[0].url, /\/api\//);
});

test('static PDF links stay within the public data folder instead of requiring the backend', async () => {
  const { apiUrl } = await import('../../website/js/helpers.js');
  const url = new URL(apiUrl('/api/public/files/pdf-example?v=2&download=1'));
  assert.match(url.pathname, /website\/data\/files\/pdf-example\.pdf$/);
  assert.equal(url.searchParams.get('v'), '2');
});

test('the public site contains no private data, build tree or package installation requirements', async () => {
  const entries = await readdir(site);
  for (const name of [
    '.local',
    'backend',
    'server',
    'src',
    'dist',
    'node_modules',
    'package.json',
  ]) {
    assert.equal(entries.includes(name), false, `${name} must stay outside the public frontend`);
  }
});
