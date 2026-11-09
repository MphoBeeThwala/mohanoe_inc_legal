import type { DbRow, RequestBody, Actor } from '../types/db';
import { createHmac, randomUUID } from 'crypto';
import { getSupabaseClient } from '../config/supabase';
import { requireSecret } from '../config/env';

const memory: { events: DbRow[]; lastHash: string } = {
  events: [],
  lastHash: 'genesis',
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

function normalizeActor(actor: Actor = {}) {
  return {
    actor_id: actor.userId || actor.id || null,
    actor_name: actor.fullName || actor.email || 'system',
    actor_role: actor.role || 'system',
  };
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

function hashEvent(record: DbRow, previousHash: string) {
  const payload = canonicalize({
    actor_id: record.actor_id,
    actor_name: record.actor_name,
    actor_role: record.actor_role,
    action: record.action,
    created_at: record.created_at,
    details: record.details,
    entity_id: record.entity_id,
    entity_type: record.entity_type,
    previous_hash: previousHash,
    summary: record.summary,
  });

  return createHmac('sha256', requireSecret('AUDIT_CHAIN_SECRET', 'local-development-audit-secret'))
    .update(payload)
    .digest('hex');
}

async function insertEvent(record: DbRow) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('audit_events').insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory.events.unshift(record);
  memory.lastHash = record.entry_hash;
  return record;
}

async function logEvent(input: RequestBody = {}, actor: Actor = {}) {
  const previousHash = memory.events[0]?.entry_hash || process.env.AUDIT_CHAIN_SEED || 'genesis';
  const record: DbRow = {
    id: randomUUID(),
    entity_type: input.entityType || 'system',
    entity_id: input.entityId || null,
    action: input.action || 'event',
    summary: String(input.summary || '').trim(),
    details: input.details || {},
    ...normalizeActor(actor),
    created_at: toIso(),
    previous_hash: previousHash,
  };
  record.entry_hash = hashEvent(record, previousHash);

  return insertEvent(record);
}

async function listEvents(filters: RequestBody = {}) {
  const db = getSupabaseClient();
  if (db) {
    let query = db.from('audit_events').select('*').order('created_at', {
      ascending: false,
    });

    if (filters.entityType) {
      query = query.eq('entity_type', filters.entityType);
    }

    if (filters.entityId) {
      query = query.eq('entity_id', filters.entityId);
    }

    const { data, error } = await query;
    if (error) {
      throw error;
    }

    return data || [];
  }

  return memory.events.filter((entry) => {
    if (filters.entityType && entry.entity_type !== filters.entityType) {
      return false;
    }

    if (filters.entityId && String(entry.entity_id) !== String(filters.entityId)) {
      return false;
    }

    return true;
  });
}

async function verifyEventChain() {
  const events = await listEvents();
  let previousHash = process.env.AUDIT_CHAIN_SEED || 'genesis';

  for (const event of events.slice().reverse()) {
    const expected = hashEvent(
      {
        actor_id: event.actor_id,
        actor_name: event.actor_name,
        actor_role: event.actor_role,
        action: event.action,
        created_at: event.created_at,
        details: event.details,
        entity_id: event.entity_id,
        entity_type: event.entity_type,
        summary: event.summary,
      },
      previousHash,
    );

    if (event.previous_hash !== previousHash || event.entry_hash !== expected) {
      return {
        valid: false,
        brokenAt: event.id,
        action: event.action,
      };
    }

    previousHash = event.entry_hash;
  }

  return {
    valid: true,
    count: events.length,
  };
}

export { listEvents, logEvent, verifyEventChain };
