import { sql } from 'drizzle-orm';
import { counters } from './schema';
import { db, type Executor } from './client';

/**
 * Atomically increments and returns the named counter, starting at 1.
 * Safe under concurrency: the upsert takes a row lock, so two requests can
 * never receive the same value.
 */
export async function nextValue(name: string, exec: Executor = db()): Promise<number> {
  const [row] = await exec
    .insert(counters)
    .values({ name, value: 1 })
    .onConflictDoUpdate({ target: counters.name, set: { value: sql`${counters.value} + 1` } })
    .returning({ value: counters.value });
  if (!row) {
    throw new Error(`Counter ${name} could not be incremented`);
  }
  return row.value;
}
