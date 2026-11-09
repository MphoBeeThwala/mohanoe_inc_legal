import type { DbRow, RequestBody, Actor } from '../types/db';
import { httpError } from '../lib/http';
import { randomUUID } from 'crypto';
import { getSupabaseClient } from '../config/supabase';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

const memory: Record<string, DbRow[]> = {
  tasks: [],
  timeline: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

async function writeRow(table: string, memoryKey: string, record: DbRow) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from(table).insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory[memoryKey].push(record);
  return record;
}

async function updateCaseRecord(caseId: string, patch: RequestBody) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('cases')
      .update(patch)
      .eq('id', caseId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  const cases = await intakeService.listCases();
  const current = cases.find((item) => item.id === caseId || item.caseNumber === caseId);
  if (!current) {
    return null;
  }

  const updated = { ...current, ...patch };
  return updated;
}

async function getCasesIndex() {
  const cases = await intakeService.listCases();
  const tasks = await listTasks();
  const timeline = await listTimeline();

  return cases.map((item) => ({
    ...item,
    taskCount: tasks.filter((task) => task.case_id === item.id).length,
    openTaskCount: tasks.filter(
      (task) => task.case_id === item.id && task.status !== 'done',
    ).length,
    timelineCount: timeline.filter((entry) => entry.case_id === item.id).length,
  }));
}

async function getCase(caseId: string) {
  const cases = await intakeService.listCases();
  const current = cases.find(
    (item) =>
      item.id === caseId ||
      item.caseNumber === caseId ||
      item.submissionId === caseId,
  );
  if (!current) {
    return null;
  }

  return {
    ...current,
    tasks: (await listTasks()).filter((task) => task.case_id === current.id),
    timeline: (await listTimeline()).filter(
      (entry) => entry.case_id === current.id,
    ),
  };
}

async function listTasks() {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('case_tasks').select('*').order('created_at', {
      ascending: false,
    });
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory.tasks].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function listTimeline() {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('case_timeline')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory.timeline].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function addTask(caseId: string, input: RequestBody, actor: Actor = {}) {
  const caseRecord = await getCase(caseId);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }

  const title = String(input.title || '').trim();
  if (!title) {
    throw httpError('Task title is required', 400);
  }

  const task = {
    id: randomUUID(),
    case_id: caseRecord.id,
    title,
    description: String(input.description || '').trim(),
    status: 'open',
    due_date: input.dueDate || null,
    assignee_name: input.assigneeName || null,
    created_by: actor?.fullName || actor?.email || 'system',
    created_at: toIso(),
    completed_at: null,
  };

  const saved = await writeRow('case_tasks', 'tasks', task);
  await auditService
    .logEvent(
      {
        entityType: 'case_task',
        entityId: saved.id,
        action: 'task_created',
        summary: `Task created: ${task.title}`,
        details: { caseId: caseRecord.id },
      },
      actor,
    )
    .catch(() => {});
  await addTimeline(caseRecord.id, {
    eventType: 'task_created',
    message: `Task created: ${task.title}`,
    metadata: { taskId: task.id },
  }, actor);

  return saved;
}

async function completeTask(caseId: string, taskId: string, actor: Actor = {}) {
  const caseRecord = await getCase(caseId);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }

  const tasks = await listTasks();
  const existing = tasks.find(
    (task) => task.id === taskId && task.case_id === caseRecord.id,
  );
  if (!existing) {
    throw httpError('Task not found', 404);
  }

  const patch = {
    ...existing,
    status: 'done',
    completed_at: toIso(),
  };

  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('case_tasks')
      .update({ status: 'done', completed_at: patch.completed_at })
      .eq('id', taskId)
      .select()
      .single();
    if (error) {
      throw error;
    }
  } else {
    const index = memory.tasks.findIndex((task) => task.id === taskId);
    if (index >= 0) {
      memory.tasks[index] = patch;
    }
  }

  await addTimeline(caseId, {
    eventType: 'task_completed',
    message: `Task completed: ${existing.title}`,
    metadata: { taskId },
  }, actor);
  await auditService
    .logEvent(
      {
        entityType: 'case_task',
        entityId: existing.id,
        action: 'task_completed',
        summary: `Task completed: ${existing.title}`,
        details: { caseId: caseRecord.id },
      },
      actor,
    )
    .catch(() => {});

  return patch;
}

async function updateCaseStatus(caseId: string, input: RequestBody, actor: Actor = {}) {
  const caseRecord = await getCase(caseId);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }

  const status = String(input.status || '').trim();
  if (!status) {
    throw httpError('status is required', 400);
  }

  const updated = await updateCaseRecord(caseRecord.id, {
    status,
    updated_at: toIso(),
    next_action: input.nextAction || caseRecord.nextAction,
  });

  await addTimeline(caseRecord.id, {
    eventType: 'status_changed',
    message: `Case status changed to ${status}`,
    metadata: { previousStatus: caseRecord.status, newStatus: status },
  }, actor);
  await auditService
    .logEvent(
      {
        entityType: 'case',
        entityId: caseRecord.id,
        action: 'case_status_changed',
        summary: `Case status changed to ${status}`,
        details: { previousStatus: caseRecord.status, newStatus: status },
      },
      actor,
    )
    .catch(() => {});

  return updated;
}

async function addTimeline(caseId: string, input: RequestBody, actor: Actor = {}) {
  const entry = {
    id: randomUUID(),
    case_id: caseId,
    event_type: input.eventType || 'note',
    message: String(input.message || '').trim(),
    metadata: input.metadata || {},
    actor_name: actor?.fullName || actor?.email || 'system',
    created_at: toIso(),
  };

  const saved = await writeRow('case_timeline', 'timeline', entry);
  await auditService
    .logEvent(
      {
        entityType: 'case_timeline',
        entityId: saved.id,
        action: 'timeline_note_added',
        summary: entry.message,
        details: {
          caseId,
          eventType: entry.event_type,
        },
      },
      actor,
    )
    .catch(() => {});
  return saved;
}

async function deleteByCaseIds(caseIds: DbRow[] = []) {
  if (!caseIds.length) {
    return 0;
  }

  const normalized = new Set(caseIds.map((value) => String(value)));
  const db = getSupabaseClient();
  if (db) {
    const { error } = await db.from('case_tasks').delete().in('case_id', [...normalized]);
    if (error) {
      throw error;
    }

    const { error: timelineError } = await db
      .from('case_timeline')
      .delete()
      .in('case_id', [...normalized]);
    if (timelineError) {
      throw timelineError;
    }
  } else {
    memory.tasks = memory.tasks.filter((task) => !normalized.has(String(task.case_id)));
    memory.timeline = memory.timeline.filter((entry) => !normalized.has(String(entry.case_id)));
  }

  return normalized.size;
}

export {
  addTask,
  addTimeline,
  completeTask,
  getCase,
  getCasesIndex,
  listTasks,
  listTimeline,
  deleteByCaseIds,
  updateCaseStatus,
};
