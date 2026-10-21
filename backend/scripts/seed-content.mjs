import { mkdir, writeFile } from 'node:fs/promises';
import { initialState } from '../server/state.js';
await mkdir('.local/content-seed', { recursive: true });
await writeFile('.local/content-seed/portal-state.json', JSON.stringify(initialState(), null, 2));
console.log(
  'Created .local/content-seed/portal-state.json. Place it in the PRIVATE content repository only.',
);
