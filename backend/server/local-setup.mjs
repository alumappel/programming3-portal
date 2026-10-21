import { checkOrigin, passwordHash, randomToken } from './auth.js';
import { HttpError } from './state.js';
import { json } from './app.js';

// Local setup only. The Cloudflare Worker never mounts this handler.
export async function localSetup(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  ).run();
  const stored = await env.DB.prepare('SELECT value FROM local_settings WHERE key = ?')
    .bind('admin_credentials').first();
  if (stored && !env.ADMIN_PASSWORD_HASH) {
    const credentials = JSON.parse(stored.value);
    if (credentials.version !== 1 || !/^[a-f0-9]{64}$/.test(credentials.salt) || !/^[a-f0-9]{64}$/.test(credentials.hash)) {
      throw new Error('The saved local credentials are invalid. Restore the private database backup.');
    }
    env.ADMIN_SALT = credentials.salt;
    env.ADMIN_PASSWORD_HASH = credentials.hash;
  }

  return async (request) => {
    try {
      if (!env.LOCAL_DEV) throw new HttpError(404, 'הכתובת אינה קיימת.');
      if (request.method === 'GET') return json({ needsSetup: !env.ADMIN_PASSWORD_HASH });
      if (request.method !== 'POST') throw new HttpError(405, 'הפעולה אינה נתמכת.');
      checkOrigin(request, env);
      if (env.ADMIN_PASSWORD_HASH) throw new HttpError(409, 'כבר הוגדרה סיסמה. יש להתחבר לעורך.');
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'הבקשה אינה תקינה.');
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 2048) throw new HttpError(413, 'הבקשה גדולה מדי.');
      let body;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new HttpError(400, 'הבקשה אינה תקינה.'); }
      if (typeof body?.password !== 'string' || body.password.length < 12 || body.password.length > 200) {
        throw new HttpError(422, 'בחרו סיסמה באורך 12 עד 200 תווים.');
      }
      const salt = randomToken(), hash = await passwordHash(body.password, salt);
      const result = await env.DB.prepare('INSERT OR IGNORE INTO local_settings (key,value) VALUES (?,?)')
        .bind('admin_credentials', JSON.stringify({ version: 1, salt, hash })).run();
      if (Number(result.changes) !== 1) throw new HttpError(409, 'כבר הוגדרה סיסמה בלשונית אחרת. יש להתחבר לעורך.');
      env.ADMIN_SALT = salt;
      env.ADMIN_PASSWORD_HASH = hash;
      return json({ ok: true }, 201);
    } catch (error) {
      return json({ error: error.status ? error.message : 'לא ניתן לשמור את הסיסמה. נסו שוב.' }, error.status || 500);
    }
  };
}
