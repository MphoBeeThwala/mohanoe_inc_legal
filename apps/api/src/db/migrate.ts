// Applies pending migrations and exits: `npm run db:migrate -w apps/api`.
// The server also migrates on start unless DB_MIGRATE_ON_START=false.
import '../load-env';
import { closeDb, initDb } from './client';

initDb()
  .then(async () => {
    console.log('Database migrations applied.');
    await closeDb();
  })
  .catch(async (error: unknown) => {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    await closeDb().catch(() => {});
    process.exit(1);
  });
