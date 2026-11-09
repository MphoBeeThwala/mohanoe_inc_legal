// Audit anchors: periodic copies of each firm's audit chain head.
//
// The hash chain (audit.service.ts) shows that no event was changed after it
// was written, but someone holding AUDIT_CHAIN_SECRET and database access
// could rebuild the whole chain. Anchors close that gap: each one records the
// head (last seq, its hash, the event count) in the database and, when an
// object store is configured, as a write-once object in an immutable (WORM)
// container. Verification then checks every anchor against the events.
//
// Run daily: `npm run ops -w apps/api -- anchor` (a scheduled job), or set
// AUDIT_ANCHOR_INTERVAL_HOURS to anchor from the API process.
import { asc, count, desc, eq, lte } from 'drizzle-orm';
import type { AuditTrailVerification } from '@ahava88/shared';
import { db, rootDb } from '../db/client';
import { withTenant } from '../db/tenant';
import { currentFirm } from '../db/tenant-context';
import { auditAnchors, auditEvents, firms, type AuditAnchorRow } from '../db/schema';
import { iso } from '../lib/time';
import { anchorContainer, objectStore } from './object-store';
import { verifyEventChain } from './audit.service';

interface AnchorDocument {
  firmId: string;
  lastSeq: number;
  lastHash: string;
  eventCount: number;
  anchoredAt: string;
}

/** Anchors the current firm's chain head. Returns null when nothing changed. */
export async function anchorCurrentFirm(): Promise<AuditAnchorRow | null> {
  const [head] = await db()
    .select({ seq: auditEvents.seq, hash: auditEvents.entryHash })
    .from(auditEvents)
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  if (!head) {
    return null;
  }
  const [previous] = await db()
    .select()
    .from(auditAnchors)
    .orderBy(desc(auditAnchors.lastSeq))
    .limit(1);
  if (previous && previous.lastSeq === head.seq) {
    return null;
  }
  const [{ value: eventCount } = { value: 0 }] = await db()
    .select({ value: count() })
    .from(auditEvents)
    .where(lte(auditEvents.seq, head.seq));

  const firm = currentFirm();
  const anchoredAt = new Date();
  const document: AnchorDocument = {
    firmId: firm.id,
    lastSeq: head.seq,
    lastHash: head.hash,
    eventCount,
    anchoredAt: anchoredAt.toISOString(),
  };
  let objectKey: string | null = null;
  const store = objectStore();
  if (store) {
    objectKey = `${firm.id}/${document.anchoredAt.replace(/[:.]/g, '-')}-${head.seq}.json`;
    // Write-once: never replace an existing anchor.
    await store.put(anchorContainer(), objectKey, Buffer.from(JSON.stringify(document)), {
      overwrite: false,
    });
  }
  const [saved] = await db()
    .insert(auditAnchors)
    .values({
      lastSeq: head.seq,
      lastHash: head.hash,
      eventCount,
      objectKey,
      createdAt: anchoredAt,
    })
    .returning();
  return saved ?? null;
}

/** Anchors every active firm (the scheduled job). */
export async function anchorAllFirms(): Promise<{ firm: string; anchored: boolean }[]> {
  const all = await rootDb().select().from(firms).where(eq(firms.status, 'active'));
  const results: { firm: string; anchored: boolean }[] = [];
  for (const firm of all) {
    const anchor = await withTenant(firm, () => anchorCurrentFirm(), { system: true });
    results.push({ firm: firm.slug, anchored: Boolean(anchor) });
  }
  return results;
}

/** Verifies the chain and every anchor of the current firm. */
export async function verifyAuditTrail(): Promise<AuditTrailVerification> {
  const chain = await verifyEventChain();
  const anchors = await db().select().from(auditAnchors).orderBy(asc(auditAnchors.lastSeq));
  const problems: string[] = [];
  const store = objectStore();

  for (const anchor of anchors) {
    const label = `Anchor of ${iso(anchor.createdAt).slice(0, 10)} (event #${anchor.lastSeq})`;
    const [event] = await db()
      .select({ hash: auditEvents.entryHash })
      .from(auditEvents)
      .where(eq(auditEvents.seq, anchor.lastSeq))
      .limit(1);
    if (!event) {
      problems.push(`${label}: the anchored event is missing`);
      continue;
    }
    if (event.hash !== anchor.lastHash) {
      problems.push(`${label}: the anchored event has changed`);
    }
    const [{ value: upTo } = { value: 0 }] = await db()
      .select({ value: count() })
      .from(auditEvents)
      .where(lte(auditEvents.seq, anchor.lastSeq));
    if (upTo !== anchor.eventCount) {
      problems.push(`${label}: ${anchor.eventCount} events were anchored, ${upTo} are present now`);
    }
    if (anchor.objectKey && store) {
      try {
        const stored = JSON.parse(
          (await store.get(anchorContainer(), anchor.objectKey)).toString('utf8'),
        ) as AnchorDocument;
        if (
          stored.lastSeq !== anchor.lastSeq ||
          stored.lastHash !== anchor.lastHash ||
          stored.eventCount !== anchor.eventCount ||
          stored.firmId !== currentFirm().id
        ) {
          problems.push(`${label}: the database copy differs from the immutable copy`);
        }
      } catch {
        problems.push(`${label}: the immutable copy could not be read`);
      }
    }
  }

  const last = anchors[anchors.length - 1];
  return {
    ...chain,
    anchors: {
      checked: anchors.length,
      lastAnchoredAt: last ? iso(last.createdAt) : null,
      problems,
    },
    trustworthy: chain.valid && problems.length === 0,
  };
}

/** Optional in-process schedule (AUDIT_ANCHOR_INTERVAL_HOURS). */
export function scheduleAnchoring(): NodeJS.Timeout | null {
  const hours = Number(process.env.AUDIT_ANCHOR_INTERVAL_HOURS || 0);
  if (!Number.isFinite(hours) || hours <= 0) {
    return null;
  }
  const run = () =>
    anchorAllFirms().catch((error: unknown) =>
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'audit_anchor_failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  const timer = setInterval(run, hours * 3_600_000);
  timer.unref();
  setTimeout(run, 60_000).unref();
  return timer;
}
