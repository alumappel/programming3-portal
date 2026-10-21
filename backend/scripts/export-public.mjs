import { DatabaseSync } from 'node:sqlite';
import { exportPublished } from '../server/static-export.mjs';

// Optional: copy published content to the static file. Drafts are never exported.
const db = new DatabaseSync(new URL('../.local/portal.sqlite', import.meta.url), {
  readOnly: true,
});
try {
  await exportPublished({
    async read() { return JSON.parse(db.prepare('SELECT value FROM content WHERE id=1').get().value); },
    async getFile(id) { return db.prepare('SELECT value FROM files WHERE id=?').get(id)?.value; },
  }, new URL('../../website/data/', import.meta.url));
  console.log('Published content copied to website/data. Drafts were not exported.');
} finally {
  db.close();
}
