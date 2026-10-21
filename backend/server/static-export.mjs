import { mkdir, writeFile, rename, rm } from 'node:fs/promises';

// Write only published records. PDFs are present before the JSON pointer is replaced.
export async function exportPublished(store, directory) {
  const { live } = await store.read(true);
  await mkdir(directory, { recursive: true });
  for (const file of live.content.files) {
    if (!/^[a-zA-Z0-9_-]+$/.test(file.id)) throw new Error('Invalid published file ID');
    const bytes = await store.getFile(file.id);
    if (!bytes) throw new Error('Published PDF is missing');
    await mkdir(new URL('files/', directory), { recursive: true });
    await writeFile(new URL(`files/${file.id}.pdf`, directory), bytes);
  }
  const temporary = new URL(`.content-${crypto.randomUUID()}.tmp`, directory);
  try {
    await writeFile(temporary, JSON.stringify(live, null, 2) + '\n');
    await rename(temporary, new URL('content.json', directory));
  } finally {
    await rm(temporary, { force: true });
  }
  return live.version;
}
