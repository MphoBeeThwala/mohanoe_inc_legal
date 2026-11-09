// Restore check: run against a restored database (e.g. the quarterly restore
// test) to show the restore is usable, not merely present:
//   - every migration in this build has been applied;
//   - each firm's audit chain and anchors verify;
//   - each firm's data key unwraps (Key Vault / local KEK) and real encrypted
//     records decrypt;
//   - row counts, to compare with production at the restore point.
// It reads only, and reports counts and outcomes, never personal data.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { count, eq, isNotNull, sql } from 'drizzle-orm';
import { db, rootDb, MIGRATIONS_FOLDER } from '../db/client';
import { withTenant } from '../db/tenant';
import {
  auditEvents,
  calendarEvents,
  cases,
  firms,
  invoices,
  parties,
  submissions,
  timeEntries,
} from '../db/schema';
import { decryptJson } from './privacy.service';
import { verifyAuditTrail } from './audit-anchor.service';

export interface FirmRestoreCheck {
  firm: string;
  auditTrustworthy: boolean;
  auditProblems: string[];
  decrypted: number;
  decryptFailures: string[];
  counts: Record<string, number>;
}

export interface RestoreCheck {
  ok: boolean;
  migrations: { expected: number; applied: number };
  firms: FirmRestoreCheck[];
}

async function appliedMigrations(): Promise<number> {
  const result = (await rootDb().execute(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  )) as unknown as { rows: Array<{ n: number }> };
  return result.rows[0]?.n ?? 0;
}

function expectedMigrations(): number {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

/** Tries to decrypt up to `limit` values of each encrypted kind. */
async function sampleDecrypt(limit = 5) {
  const samples: Array<{ kind: string; values: Array<string | null> }> = [
    {
      kind: 'parties',
      values: (await db().select({ v: parties.detailsEncrypted }).from(parties).limit(limit)).map(
        (row) => row.v,
      ),
    },
    {
      kind: 'intake',
      values: (
        await db().select({ v: submissions.rawPayloadEncrypted }).from(submissions).limit(limit)
      ).map((row) => row.v),
    },
    {
      kind: 'invoices',
      values: (
        await db()
          .select({ v: invoices.contentEncrypted })
          .from(invoices)
          .where(isNotNull(invoices.contentEncrypted))
          .limit(limit)
      ).map((row) => row.v),
    },
    {
      kind: 'time',
      values: (
        await db().select({ v: timeEntries.descriptionEncrypted }).from(timeEntries).limit(limit)
      ).map((row) => row.v),
    },
    {
      kind: 'calendar',
      values: (
        await db()
          .select({ v: calendarEvents.contentEncrypted })
          .from(calendarEvents)
          .where(isNotNull(calendarEvents.contentEncrypted))
          .limit(limit)
      ).map((row) => row.v),
    },
  ];
  let decrypted = 0;
  const failures: string[] = [];
  for (const sample of samples) {
    for (const value of sample.values) {
      if (!value) continue;
      try {
        await decryptJson(value);
        decrypted += 1;
      } catch {
        failures.push(sample.kind);
      }
    }
  }
  return { decrypted, failures: [...new Set(failures)] };
}

export async function restoreCheck(): Promise<RestoreCheck> {
  const migrations = { expected: expectedMigrations(), applied: await appliedMigrations() };
  const all = await rootDb().select().from(firms).where(eq(firms.status, 'active'));
  const results: FirmRestoreCheck[] = [];
  for (const firm of all) {
    results.push(
      await withTenant(
        firm,
        async () => {
          const audit = await verifyAuditTrail();
          const { decrypted, failures } = await sampleDecrypt();
          const tally = async (table: typeof cases | typeof auditEvents | typeof invoices) =>
            (await db().select({ value: count() }).from(table))[0]?.value ?? 0;
          return {
            firm: firm.slug,
            auditTrustworthy: audit.trustworthy,
            auditProblems: [
              ...(audit.valid ? [] : [`Chain broken at ${audit.brokenAt} (${audit.action})`]),
              ...audit.anchors.problems,
            ].slice(0, 10),
            decrypted,
            decryptFailures: failures,
            counts: {
              matters: await tally(cases),
              auditEvents: await tally(auditEvents),
              invoices: await tally(invoices),
            },
          };
        },
        { system: true },
      ),
    );
  }
  return {
    ok:
      migrations.applied >= migrations.expected &&
      results.every((firm) => firm.auditTrustworthy && !firm.decryptFailures.length),
    migrations,
    firms: results,
  };
}
