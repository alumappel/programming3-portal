import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { initialState, conflict } from './state.js';
export function localStore(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(resolve(directory, 'portal.sqlite'));
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(readFileSync(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8'));
  db.exec(
    'CREATE TABLE IF NOT EXISTS content (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, value BLOB NOT NULL);',
  );
  const initial = initialState();
  db.prepare('INSERT OR IGNORE INTO content (id,revision,value) VALUES (1,?,?)').run(
    initial.revision,
    JSON.stringify(initial),
  );
  const DB = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async first() {
          return db.prepare(sql).get(...values) ?? null;
        },
        async run() {
          return db.prepare(sql).run(...values);
        },
      };
    },
  };
  return {
    kind: 'local',
    DB,
    close: () => db.close(),
    async read() {
      return JSON.parse(db.prepare('SELECT value FROM content WHERE id=1').get().value);
    },
    async write(revision, state) {
      if (
        !db
          .prepare('UPDATE content SET revision=?,value=? WHERE id=1 AND revision=?')
          .run(state.revision, JSON.stringify(state), revision).changes
      )
        throw conflict();
    },
    async putFile(id, bytes) {
      db.prepare('INSERT INTO files (id,value) VALUES (?,?)').run(id, bytes);
    },
    async getFile(id) {
      return db.prepare('SELECT value FROM files WHERE id=?').get(id)?.value ?? null;
    },
    async hasFile(id) {
      return !!db.prepare('SELECT id FROM files WHERE id=?').get(id);
    },
  };
}
