import { passwordHash, randomToken } from '../server/auth.js';
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)
  throw new Error(
    'Provide ADMIN_PASSWORD through the process environment with at least 12 characters. Never pass it as a command argument.',
  );
const salt = randomToken(),
  hash = await passwordHash(process.env.ADMIN_PASSWORD, salt);
delete process.env.ADMIN_PASSWORD;
console.log(
  `ADMIN_SALT=${salt}\nADMIN_PASSWORD_HASH=${hash}\nSet these values as Cloudflare Secrets. Do not commit them.`,
);
