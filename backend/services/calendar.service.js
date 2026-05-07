const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../config/supabase');
const caseService = require('./case.service');
const auditService = require('./audit.service');

const memory = {
  events: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

async function listRows() {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('calendar_events')
      .select('*')
      .order('starts_at', { ascending: true });
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory.events].sort((a, b) =>
    String(a.starts_at).localeCompare(String(b.starts_at)),
  );
}

async function saveRow(record) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('calendar_events').insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory.events.push(record);
  return record;
}

async function createEvent(input = {}, actor = {}) {
  const title = String(input.title || '').trim();
  const startsAt = String(input.startsAt || '').trim();
  const caseId = String(input.caseId || '').trim();

  if (!title || !startsAt || !caseId) {
    const error = new Error('caseId, title, and startsAt are required');
    error.statusCode = 400;
    throw error;
  }

  const caseRecord = await caseService.getCase(caseId);
  if (!caseRecord) {
    const error = new Error('Case not found');
    error.statusCode = 404;
    throw error;
  }

  const record = {
    id: randomUUID(),
    case_id: caseRecord.id,
    case_number: caseRecord.caseNumber,
    title,
    event_type: String(input.eventType || 'deadline').trim(),
    starts_at: startsAt,
    ends_at: input.endsAt || null,
    location: String(input.location || '').trim(),
    notes: String(input.notes || '').trim(),
    created_by: actor?.fullName || actor?.email || 'system',
    created_at: toIso(),
  };

  const saved = await saveRow(record);
  await auditService.logEvent(
    {
      entityType: 'calendar_event',
      entityId: saved.id,
      action: 'calendar_event_created',
      summary: `Calendar event created: ${title}`,
      details: {
        caseId: caseRecord.id,
      },
    },
    actor,
  );

  return {
    id: saved.id,
    caseId: saved.case_id,
    caseNumber: saved.case_number,
    title: saved.title,
    eventType: saved.event_type,
    startsAt: saved.starts_at,
    endsAt: saved.ends_at,
    location: saved.location,
    notes: saved.notes,
    createdBy: saved.created_by,
    createdAt: saved.created_at,
  };
}

async function listEvents() {
  const rows = await listRows();
  return rows.map((row) => ({
    id: row.id,
    caseId: row.case_id,
    caseNumber: row.case_number,
    title: row.title,
    eventType: row.event_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

async function getUpcomingEvents(limit = 8) {
  const rows = await listEvents();
  const tasks = await caseService.listTasks();
  const taskEvents = tasks
    .filter((task) => task.due_date && task.status !== 'done')
    .map((task) => ({
      id: `task-${task.id}`,
      type: 'task',
      caseId: task.case_id,
      title: task.title,
      startsAt: task.due_date,
      status: task.status,
      assigneeName: task.assignee_name,
    }));

  return [...rows, ...taskEvents]
    .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))
    .slice(0, limit);
}

module.exports = {
  createEvent,
  getUpcomingEvents,
  listEvents,
};
