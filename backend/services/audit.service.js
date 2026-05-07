const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../config/supabase');

const memory = {
  events: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

function normalizeActor(actor = {}) {
  return {
    actor_id: actor.userId || actor.id || null,
    actor_name: actor.fullName || actor.email || 'system',
    actor_role: actor.role || 'system',
  };
}

async function insertEvent(record) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('audit_events').insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory.events.unshift(record);
  return record;
}

async function logEvent(input = {}, actor = {}) {
  const record = {
    id: randomUUID(),
    entity_type: input.entityType || 'system',
    entity_id: input.entityId || null,
    action: input.action || 'event',
    summary: String(input.summary || '').trim(),
    details: input.details || {},
    ...normalizeActor(actor),
    created_at: toIso(),
  };

  return insertEvent(record);
}

async function listEvents(filters = {}) {
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

module.exports = {
  listEvents,
  logEvent,
};
