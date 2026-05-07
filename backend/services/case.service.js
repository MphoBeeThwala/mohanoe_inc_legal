const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../config/supabase');
const intakeService = require('./intake.service');
const auditService = require('./audit.service');

const memory = {
  tasks: [],
  timeline: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

async function writeRow(table, memoryKey, record) {
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

async function updateCaseRecord(caseId, patch) {
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

async function getCase(caseId) {
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

async function addTask(caseId, input, actor) {
  const caseRecord = await getCase(caseId);
  if (!caseRecord) {
    const error = new Error('Case not found');
    error.statusCode = 404;
    throw error;
  }

  const title = String(input.title || '').trim();
  if (!title) {
    const error = new Error('Task title is required');
    error.statusCode = 400;
    throw error;
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

async function completeTask(caseId, taskId, actor) {
  const caseRecord = await getCase(caseId);
  if (!caseRecord) {
    const error = new Error('Case not found');
    error.statusCode = 404;
    throw error;
  }

  const tasks = await listTasks();
  const existing = tasks.find(
    (task) => task.id === taskId && task.case_id === caseRecord.id,
  );
  if (!existing) {
    const error = new Error('Task not found');
    error.statusCode = 404;
    throw error;
  }

  const patch = {
    ...existing,
    status: 'done',
    completed_at: toIso(),
  };

  if (getSupabaseClient()) {
    const db = getSupabaseClient();
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

async function updateCaseStatus(caseId, input, actor) {
  const caseRecord = await getCase(caseId);
  if (!caseRecord) {
    const error = new Error('Case not found');
    error.statusCode = 404;
    throw error;
  }

  const status = String(input.status || '').trim();
  if (!status) {
    const error = new Error('status is required');
    error.statusCode = 400;
    throw error;
  }

  const updated = await updateCaseRecord(caseRecord.id, {
    status,
    updated_at: toIso(),
    next_action: input.nextAction || caseRecord.nextAction || caseRecord.next_action,
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

async function addTimeline(caseId, input, actor) {
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

module.exports = {
  addTask,
  addTimeline,
  completeTask,
  getCase,
  getCasesIndex,
  listTasks,
  listTimeline,
  updateCaseStatus,
};
