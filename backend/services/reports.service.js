const intakeService = require('./intake.service');
const caseService = require('./case.service');
const billingService = require('./billing.service');
const calendarService = require('./calendar.service');
const notificationsService = require('./notifications.service');
const auditService = require('./audit.service');
const { getSupabaseClient } = require('../config/supabase');
const { randomUUID } = require('crypto');

const memory = {
  reports: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

async function listRows() {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('report_snapshots')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory.reports].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function saveRow(record) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('report_snapshots').insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory.reports.unshift(record);
  return record;
}

async function buildDashboard() {
  const [summary, cases, tasks, invoices, events, notifications, audit] =
    await Promise.all([
      intakeService.getSummary(),
      intakeService.listCases(),
      caseService.listTasks(),
      billingService.listInvoices(),
      calendarService.listEvents(),
      notificationsService.listNotifications(),
      auditService.listEvents(),
    ]);

  const criticalCases = cases.filter((item) => item.urgency === 'critical').length;
  const openTasks = tasks.filter((task) => task.status !== 'done').length;
  const unreadNotifications = notifications.filter((item) => !item.isRead).length;
  const upcomingHearings = events.filter((event) =>
    ['hearing', 'client_meeting', 'deadline'].includes(event.eventType),
  ).length;
  const overdueInvoices = invoices.filter((invoice) => invoice.status !== 'paid').length;

  return {
    generatedAt: toIso(),
    summary,
    caseCount: cases.length,
    criticalCases,
    openTasks,
    overdueInvoices,
    unreadNotifications,
    upcomingHearings,
    auditEvents: audit.length,
    casesByStatus: cases.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {}),
    casesByPracticeArea: cases.reduce((acc, item) => {
      acc[item.practiceArea] = (acc[item.practiceArea] || 0) + 1;
      return acc;
    }, {}),
  };
}

async function generateSnapshot(input = {}, actor = {}) {
  const reportType = String(input.reportType || 'dashboard').trim();
  const payload = await buildDashboard();
  const record = {
    id: randomUUID(),
    report_type: reportType,
    title: String(input.title || 'Operational snapshot').trim(),
    payload,
    created_by: actor?.fullName || actor?.email || 'system',
    created_at: toIso(),
  };

  const saved = await saveRow(record);
  await auditService
    .logEvent(
      {
        entityType: 'report',
        entityId: saved.id,
        action: 'report_generated',
        summary: record.title,
      },
      actor,
    )
    .catch(() => {});

  return {
    id: saved.id,
    reportType: saved.report_type,
    title: saved.title,
    payload: saved.payload,
    createdBy: saved.created_by,
    createdAt: saved.created_at,
  };
}

async function listSnapshots() {
  return listRows().then((rows) =>
    rows.map((row) => ({
      id: row.id,
      reportType: row.report_type,
      title: row.title,
      payload: row.payload,
      createdBy: row.created_by,
      createdAt: row.created_at,
    })),
  );
}

module.exports = {
  buildDashboard,
  generateSnapshot,
  listSnapshots,
};
