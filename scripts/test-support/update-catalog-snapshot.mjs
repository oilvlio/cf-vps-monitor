import { writeFile } from 'node:fs/promises';
import { snapshot } from './catalog-snapshot.mjs';
import { createRealPostgresDatabase } from './real-postgres.mjs';

if (!process.argv.includes('--write')) throw new Error('Use --write to update the golden catalog; review the resulting diff.');
const database = await createRealPostgresDatabase();
try {
  const catalog = await snapshot(database.client);
  await writeFile(new URL('./terminal-catalog.json', import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
} finally {
  await database.close();
}
