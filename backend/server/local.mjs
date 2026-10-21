import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApi, json } from './app.js';
import { localStore } from './local-store.mjs';
import { passwordHash, randomToken } from './auth.js';
import { localSetup } from './local-setup.mjs';
import { exportPublished } from './static-export.mjs';

const backendRoot = fileURLToPath(new URL('../', import.meta.url));
const websiteRoot = fileURLToPath(new URL('../../website/', import.meta.url));
const publicDirectory = process.env.PORTAL_PUBLIC_DIR
  ? pathToFileURL(resolve(process.env.PORTAL_PUBLIC_DIR) + sep)
  : new URL('../../website/data/', import.meta.url);
const port = Number(process.env.PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const store = localStore(process.env.PORTAL_DATA_DIR || resolve(backendRoot, '.local'));
const env = {
  DB: store.DB,
  ADMIN_ORIGIN: origin,
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:5500',
  LOCAL_DEV: true,
};
await env.DB.prepare('DELETE FROM sessions').run();
if (process.env.ADMIN_PASSWORD) {
  if (process.env.ADMIN_PASSWORD.length < 12)
    throw new Error('יש לבחור סיסמה באורך 12 תווים לפחות.');
  env.ADMIN_SALT = randomToken();
  env.ADMIN_PASSWORD_HASH = await passwordHash(process.env.ADMIN_PASSWORD, env.ADMIN_SALT);
  delete process.env.ADMIN_PASSWORD;
}
const api = createApi(env, store);
const setup = await localSetup(env);
let exportQueue = Promise.resolve();
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

export const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== `127.0.0.1:${port}`) {
      outgoing.writeHead(403);
      outgoing.end('Use the printed local URL.');
      return;
    }
    const url = new URL(incoming.url, origin);
    let response;
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 6 * 1024 * 1024) {
          outgoing.writeHead(413);
          outgoing.end('הבקשה גדולה מדי');
          return;
        }
        chunks.push(chunk);
      }
      const request = new Request(url, {
          method: incoming.method,
          headers: incoming.headers,
          ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}),
      });
      response = url.pathname === '/api/local/setup' ? await setup(request) : await api(request);
      if (url.pathname === '/api/admin/publish' && incoming.method === 'POST' && response.ok) {
        const result = await response.json();
        exportQueue = exportQueue.catch(() => {}).then(() => exportPublished(store, publicDirectory));
        try {
          await exportQueue;
          response = json({ ...result, staticPublished: true });
        } catch {
          response = json({ ...result, staticPublished: false, warning: 'התוכן פורסם בשירות, אך העדכון ל־Live Server לא הושלם. הפעילו npm run export בתיקיית backend ונסו לרענן.' });
        }
      }
    } else if (url.pathname === '/admin' || url.pathname === '/admin/') {
      response = Response.redirect(`${origin}/admin.html`, 302);
    } else {
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      const path = resolve(websiteRoot, relative);
      if (
        !path.startsWith(resolve(websiteRoot) + sep) ||
        relative.split('/').some((p) => p.startsWith('.')) ||
        !(await stat(path)).isFile()
      )
        throw new Error('Not found');
      response = new Response(await readFile(path), {
        headers: {
          'Content-Type': types[extname(path)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        },
      });
      const admin = relative === 'admin.html';
      response.headers.set(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://docs.google.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${admin ? "'none'" : "'self'"}`,
      );
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    outgoing.end('הקובץ לא נמצא.');
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Editor: ${origin}/admin.html\nStudent site: ${origin}/index.html\n${env.ADMIN_PASSWORD_HASH ? 'Sign in as Admin with the saved password.' : 'Open the editor to choose your password once.'}\nFrontend editing: open website/index.html with Live Server.`,
  ),
);
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the previous server first.` : 'The local server could not start.');
  store.close();
  process.exit(1);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
