import { HttpError } from './state.js';
const encoder = new TextEncoder();
export const bytesToHex = (bytes) =>
  Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (value) =>
  bytesToHex(
    await crypto.subtle.digest(
      'SHA-256',
      typeof value === 'string' ? encoder.encode(value) : value,
    ),
  );
export const randomToken = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return bytesToHex(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
      key,
      256,
    ),
  );
}
export function constantEqual(a, b) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export function cookie(value, secure, maxAge = 28800) {
  return `portal_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export function checkOrigin(request, env) {
  if (request.headers.get('Origin') !== env.ADMIN_ORIGIN)
    throw new HttpError(403, 'מקור הבקשה אינו מורשה. יש להיכנס לעורך בכתובת השירות.');
}
export async function session(request, env, write = false) {
  const token = request.headers
    .get('Cookie')
    ?.match(/(?:^|;\s*)portal_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) throw new HttpError(401, 'יש להתחבר לעורך.');
  const hash = await sha256(token),
    now = Date.now();
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .bind(hash)
    .first();
  if (!row || now - row.touched_at >= 1800000 || now - row.created_at >= 28800000) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    throw new HttpError(401, 'החיבור לעורך פג. התחברו שוב; השינויים במסך נשמרים עד לטעינה מחדש.');
  }
  if (write) {
    checkOrigin(request, env);
    if (!constantEqual(request.headers.get('X-CSRF-Token') || '', row.csrf))
      throw new HttpError(403, 'אימות הפעולה נכשל. התחברו מחדש.');
  }
  await env.DB.prepare('UPDATE sessions SET touched_at = ? WHERE token_hash = ?')
    .bind(now, hash)
    .run();
  return { ...row, hash };
}
export async function login(request, env, body) {
  checkOrigin(request, env);
  if (!env.ADMIN_PASSWORD_HASH || !env.ADMIN_SALT)
    throw new HttpError(503, 'טרם הוגדרה סיסמת מנהלת בשרת. הפעילו את start.ps1 לפי מדריך ההקמה.');
  if (
    typeof body.username !== 'string' ||
    typeof body.password !== 'string' ||
    body.username.length > 100 ||
    body.password.length > 200
  )
    throw new HttpError(400, 'פרטי כניסה אינם תקינים.');
  const key = await sha256(request.headers.get('CF-Connecting-IP') || env.LOCAL_IP || 'unknown');
  const now = Date.now();
  await env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM sessions WHERE touched_at <= ? OR created_at <= ?')
    .bind(now - 1800000, now - 28800000)
    .run();
  await env.DB.prepare(
    'INSERT INTO login_attempts (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count = count + 1',
  )
    .bind(key, now + 900000)
    .run();
  const attempt = await env.DB.prepare('SELECT count FROM login_attempts WHERE key = ?')
    .bind(key)
    .first();
  if (attempt.count > 10)
    throw new HttpError(429, 'בוצעו ניסיונות רבים. המתינו 15 דקות לפני ניסיון נוסף.');
  const hash = await passwordHash(body.password, env.ADMIN_SALT);
  if (!constantEqual(hash, env.ADMIN_PASSWORD_HASH) || body.username !== 'Admin')
    throw new HttpError(401, 'שם המשתמש או הסיסמה אינם נכונים.');
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
  const token = randomToken(),
    csrf = randomToken();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash,csrf,created_at,touched_at) VALUES (?,?,?,?)',
  )
    .bind(await sha256(token), csrf, now, now)
    .run();
  return { token, csrf };
}
