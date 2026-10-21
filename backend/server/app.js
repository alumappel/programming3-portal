import {
  cleanContent,
  validateContent,
  publicContent,
  separateFileInstructions,
  MAX_PDF_BYTES,
} from '../../website/js/domain.js';
import { HttpError, conflict } from './state.js';
import { login, session, cookie, sha256 } from './auth.js';
export const json = (value, status = 200, extra = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
async function readLimited(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit)
    throw new HttpError(413, 'הבקשה גדולה מדי.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, 'הבקשה גדולה מדי.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function readJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new HttpError(415, 'נדרש תוכן JSON.');
  const text = new TextDecoder().decode(await readLimited(request, 900000));
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'לא ניתן לקרוא את הנתונים שנשלחו.');
  }
}
export function validatePdf(file, bytes) {
  if (!file || !/\.pdf$/i.test(file.name) || file.type !== 'application/pdf')
    throw new HttpError(400, 'יש לבחור קובץ PDF בעל סיומת וסוג קובץ מתאימים.');
  if (bytes.length < 12 || bytes.length > MAX_PDF_BYTES)
    throw new HttpError(400, 'קובץ PDF חייב להיות לא ריק ובגודל עד 5MB.');
  const text = new TextDecoder('latin1');
  if (
    !/^%PDF-1\.[0-9]|^%PDF-2\.[0-9]/.test(text.decode(bytes.slice(0, 10))) ||
    !text.decode(bytes.slice(-2048)).includes('%%EOF')
  )
    throw new HttpError(400, 'תוכן הקובץ אינו מזוהה כ־PDF תקין.');
}
export function createApi(env, store) {
  return async (request) => {
    const url = new URL(request.url),
      path = url.pathname,
      method = request.method;
    try {
      if (path === '/api/public/content' && method === 'GET') {
        const state = await store.read();
        return json(state.live, 200, {
          'Access-Control-Allow-Origin': env.PUBLIC_ORIGIN || env.ADMIN_ORIGIN,
          Vary: 'Origin',
        });
      }
      if (path === '/api/admin/login' && method === 'POST') {
        const result = await login(request, env, await readJson(request));
        return json({ csrf: result.csrf }, 200, {
          'Set-Cookie': cookie(result.token, !env.LOCAL_DEV),
        });
      }
      if (/^\/api\/(public|admin)\/files\/[a-zA-Z0-9_-]+$/.test(path) && method === 'GET') {
        const admin = path.startsWith('/api/admin/');
        if (admin) await session(request, env);
        const state = await store.read(admin),
          content = admin ? state.draft : state.live.content;
        const file = content.files.find((f) => f.id === path.split('/').at(-1));
        if (!file) throw new HttpError(404, 'הקובץ אינו זמין. ייתכן שטרם פורסם.');
        const bytes = await store.getFile(file.id);
        if (!bytes) throw new HttpError(404, 'הקובץ לא נמצא באחסון. נסו שוב או פנו למרצה.');
        const mode = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
        return new Response(bytes, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `${mode}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            'Cache-Control': admin ? 'no-store' : 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'Referrer-Policy': 'no-referrer',
          },
        });
      }
      if (!path.startsWith('/api/admin/')) throw new HttpError(404, 'הכתובת אינה קיימת.');
      const auth = await session(request, env, method !== 'GET');
      if (path === '/api/admin/session' && method === 'GET') return json({ csrf: auth.csrf });
      if (path === '/api/admin/logout' && method === 'POST') {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(auth.hash).run();
        return json({ ok: true }, 200, { 'Set-Cookie': cookie('', !env.LOCAL_DEV, 0) });
      }
      if (path === '/api/admin/state' && method === 'GET') return json(await store.read(true));
      if (path === '/api/admin/status' && method === 'GET') {
        const state = await store.read(true);
        return json({
          revision: state.revision,
          version: state.live.version,
          publishedAt: state.live.publishedAt,
          storage: store.kind,
        });
      }
      if (path === '/api/admin/backup' && method === 'GET')
        return json(await store.read(true), 200, {
          'Content-Disposition': 'attachment; filename="portal-backup.json"',
        });
      if (path === '/api/admin/upload' && method === 'POST') {
        const bytesBody = await readLimited(request, 6 * 1024 * 1024);
        let form;
        try {
          form = await new Response(bytesBody, {
            headers: { 'Content-Type': request.headers.get('Content-Type') || '' },
          }).formData();
        } catch {
          throw new HttpError(400, 'נתוני ההעלאה אינם תקינים. בחרו שוב את קובץ ה־PDF.');
        }
        const file = form.get('file');
        if (!file || typeof file.arrayBuffer !== 'function')
          throw new HttpError(400, 'לא נבחר קובץ.');
        if (file.size > MAX_PDF_BYTES) throw new HttpError(400, 'ניתן להעלות PDF עד 5MB.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        validatePdf(file, bytes);
        const state = await store.read(true);
        if (form.get('revision') !== state.revision) throw conflict();
        const version = await sha256(bytes),
          id = `pdf-${crypto.randomUUID()}`;
        const metadata = {
          id, name: file.name.slice(0, 200), size: bytes.length, version,
          createdAt: new Date().toISOString(),
        };
        const next = {
          ...state,
          revision: crypto.randomUUID(),
          savedAt: new Date().toISOString(),
          draft: separateFileInstructions({ ...state.draft, files: [...state.draft.files, metadata] }),
        };
        if (validateContent(next.draft).length)
          throw new HttpError(422, 'לא ניתן להוסיף הנחיית קובץ. בדקו את הטיוטה ואת מספר ההנחיות.');
        await store.putFile(id, bytes);
        await store.write(state.revision, next);
        const instruction = next.draft.instructions.find((item) => item.fileIds.includes(id));
        return json({ file: metadata, instruction, state: next });
      }
      const body = method === 'GET' ? null : await readJson(request);
      const state = await store.read(true);
      if (
        path === '/api/admin/publish' &&
        method === 'POST' &&
        state.operations.some((x) => x.id === body.operationId)
      ) {
        return json({
          version: state.operations.find((x) => x.id === body.operationId).version,
          state,
        });
      }
      if (body?.revision !== state.revision) throw conflict();
      let next;
      if (path === '/api/admin/draft' && method === 'PUT') {
        const errors = validateContent(body.content);
        if (errors.length) throw new HttpError(422, 'יש לתקן את השדות לפני השמירה.', errors);
        const content = cleanContent(body.content);
        const normalizedErrors = validateContent(content);
        if (normalizedErrors.length)
          throw new HttpError(422, 'יש לתקן את בלוקי ההנחיות לפני השמירה.', normalizedErrors);
        // File metadata can only originate from a successful server upload.
        if (
          content.files.some(
            (f) =>
              !state.draft.files.some((original) => JSON.stringify(original) === JSON.stringify(f)),
          )
        )
          throw new HttpError(422, 'קובץ חייב לעלות דרך מנגנון ההעלאה.');
        next = {
          ...state,
          revision: crypto.randomUUID(),
          draft: content,
          savedAt: new Date().toISOString(),
        };
      } else if (path === '/api/admin/publish' && method === 'POST') {
        if (!/^[a-f0-9-]{36}$/.test(body.operationId || ''))
          throw new HttpError(400, 'מזהה פעולת הפרסום אינו תקין.');
        const errors = validateContent(state.draft);
        if (errors.length) throw new HttpError(422, 'הפרסום נעצר. יש לתקן את התוכן.', errors);
        const content = publicContent(state.draft);
        for (const file of content.files)
          if (!(await store.hasFile(file.id)))
            throw new HttpError(422, `הקובץ ${file.name} אינו קיים באחסון. העלו אותו שוב.`);
        const version = crypto.randomUUID();
        next = {
          ...state,
          revision: crypto.randomUUID(),
          live: { version, publishedAt: new Date().toISOString(), content },
          history: [state.live, ...state.history].slice(0, 10),
          operations: [{ id: body.operationId, version }, ...state.operations].slice(0, 50),
        };
      } else if (path === '/api/admin/restore' && method === 'POST') {
        const previous = [state.live, ...state.history].find((x) => x.version === body.version);
        if (!previous) throw new HttpError(404, 'הגרסה המבוקשת אינה זמינה.');
        // Restore is a draft; another explicit publish creates a new live version.
        const files = [
          ...new Map(
            [...state.draft.files, ...previous.content.files].map((f) => [f.id, f]),
          ).values(),
        ];
        next = {
          ...state,
          revision: crypto.randomUUID(),
          draft: { ...structuredClone(previous.content), files },
          savedAt: new Date().toISOString(),
        };
      } else throw new HttpError(404, 'הפעולה אינה קיימת.');
      if (new TextEncoder().encode(JSON.stringify(next)).length > 950000)
        throw new HttpError(413, 'נפח התוכן וההיסטוריה גדול מדי. יש לגבות ולצמצם לפני הפרסום.');
      await store.write(state.revision, next);
      return json({ state: next, version: next.live.version });
    } catch (error) {
      return json(
        {
          error: error.status ? error.message : 'אירעה שגיאה בשירות. נסו שוב; הגרסה שפורסמה נשמרה.',
          details: error.details,
        },
        error.status || 500,
      );
    }
  };
}
