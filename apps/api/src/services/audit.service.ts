// Tamper-evident audit trail.
//
// Every event stores an HMAC (AUDIT_CHAIN_SECRET) over its own contents and
// the previous event's hash. Appends are serialised with a transaction-scoped
// advisory lock, so each event links to the true latest event even under
// concurrent requests, and `seq` gives the chain a strict order.
// verifyEventChain() recomputes every hash; any edited, inserted or deleted
// row breaks the chain from that point on.

import { createHmac } from 'crypto';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AuditChainResult, AuditEventRecord } from '@ahava88/shared';
import { db } from '../db/client';
import { auditEvents, type AuditEventRow } from '../db/schema';
import { requireSecret } from '../config/env';
import { actorName, type Actor } from '../lib/actor';
import { iso } from '../lib/time';

/** Arbitrary constant identifying the audit-chain advisory lock. */
const AUDIT_CHAIN_LOCK = 0x41756469; // "Audi"

export interface AuditInput {
  entityType?: string;
  entityId?: string | null;
  action?: string;
  summary?: string;
  details?: Record<string, unknown>;
}

function chainSeed(): string {
  return process.env.AUDIT_CHAIN_SEED || 'genesis';
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

interface HashableEvent {
  actorId: string | null;
  actorName: string;
  actorRole: string;
  action: string;
  createdAt: string;
  details: Record<string, unknown>;
  entityId: string | null;
  entityType: string;
  summary: string;
}

function hashEvent(event: HashableEvent, previousHash: string): string {
  // Key names match the original snake_case formula so the algorithm is stable.
  const payload = canonicalize({
    actor_id: event.actorId,
    actor_name: event.actorName,
    actor_role: event.actorRole,
    action: event.action,
    created_at: event.createdAt,
    details: event.details,
    entity_id: event.entityId,
    entity_type: event.entityType,
    previous_hash: previousHash,
    summary: event.summary,
  });

  return createHmac('sha256', requireSecret('AUDIT_CHAIN_SECRET', 'local-development-audit-secret'))
    .update(payload)
    .digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRecord(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    seq: row.seq,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    summary: row.summary,
    details: row.details,
    actorId: row.actorId,
    actorName: row.actorName,
    actorRole: row.actorRole,
    createdAt: iso(row.createdAt),
    previousHash: row.previousHash,
    entryHash: row.entryHash,
  };
}

export async function logEvent(
  input: AuditInput = {},
  actor: Actor = {},
): Promise<AuditEventRecord> {
  // Round-trip details through JSON so the hashed form equals what jsonb
  // stores (undefined values dropped, dates as strings).
  const details = JSON.parse(JSON.stringify(input.details ?? {})) as Record<string, unknown>;
  const userId = actor.userId && UUID.test(actor.userId) ? actor.userId : null;

  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
    const [last] = await tx
      .select({ entryHash: auditEvents.entryHash })
      .from(auditEvents)
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    const previousHash = last?.entryHash ?? chainSeed();

    // JS dates have millisecond precision, which timestamptz stores exactly.
    const createdAt = new Date();
    const event: HashableEvent = {
      actorId: userId,
      actorName: actorName(actor),
      actorRole: actor.role || 'system',
      action: input.action || 'event',
      createdAt: createdAt.toISOString(),
      details,
      entityId: input.entityId ?? null,
      entityType: input.entityType || 'system',
      summary: String(input.summary || '').trim(),
    };

    const [saved] = await tx
      .insert(auditEvents)
      .values({
        actorId: event.actorId,
        actorName: event.actorName,
        actorRole: event.actorRole,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        summary: event.summary,
        details: event.details,
        previousHash,
        entryHash: hashEvent(event, previousHash),
        createdAt,
      })
      .returning();
    if (!saved) {
      throw new Error('Audit event was not stored');
    }
    return toRecord(saved);
  });
}

/**
 * Records an audit event without failing the caller's request if the audit
 * write itself fails (logged instead). Use for best-effort events only.
 */
export async function logEventSafely(input: AuditInput, actor: Actor = {}): Promise<void> {
  try {
    await logEvent(input, actor);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'audit_event_failed',
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export interface AuditFilters {
  entityType?: string;
  entityId?: string;
  limit?: number;
}

export async function listEvents(filters: AuditFilters = {}): Promise<AuditEventRecord[]> {
  const conditions: SQL[] = [];
  if (filters.entityType) {
    conditions.push(eq(auditEvents.entityType, filters.entityType));
  }
  if (filters.entityId) {
    conditions.push(eq(auditEvents.entityId, filters.entityId));
  }

  const rows = await db()
    .select()
    .from(auditEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditEvents.seq))
    .limit(Math.min(filters.limit ?? 500, 2_000));
  return rows.map(toRecord);
}

export async function countEvents(): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents);
  return row?.count ?? 0;
}

/** Recomputes the whole chain in order, in pages of 1,000 events. */
export async function verifyEventChain(): Promise<AuditChainResult> {
  const pageSize = 1_000;
  let previousHash = chainSeed();
  let afterSeq = 0;
  let count = 0;

  for (;;) {
    const page = await db()
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.seq} > ${afterSeq}`)
      .orderBy(asc(auditEvents.seq))
      .limit(pageSize);
    if (!page.length) {
      break;
    }

    for (const row of page) {
      const expected = hashEvent(
        {
          actorId: row.actorId,
          actorName: row.actorName,
          actorRole: row.actorRole,
          action: row.action,
          createdAt: iso(row.createdAt),
          details: row.details,
          entityId: row.entityId,
          entityType: row.entityType,
          summary: row.summary,
        },
        previousHash,
      );
      if (row.previousHash !== previousHash || row.entryHash !== expected) {
        return { valid: false, brokenAt: row.id, action: row.action, count };
      }
      previousHash = row.entryHash;
      afterSeq = row.seq;
      count += 1;
    }
  }

  return { valid: true, count };
}
