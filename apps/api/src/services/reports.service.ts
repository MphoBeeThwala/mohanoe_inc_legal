// Practice dashboard and saved report snapshots.

import { desc, inArray, sql } from 'drizzle-orm';
import type { PracticeDashboard, ReportSnapshot } from '@ahava88/shared';
import { db } from '../db/client';
import { calendarEvents, cases, reportSnapshots, type ReportSnapshotRow } from '../db/schema';
import { actorName, type Actor } from '../lib/actor';
import { iso } from '../lib/time';
import { parse, reportSchema } from '../validation/schemas';
import * as intakeService from './intake.service';
import * as caseService from './case.service';
import * as billingService from './billing.service';
import * as notificationsService from './notifications.service';
import * as auditService from './audit.service';

const HEARING_TYPES = ['hearing', 'client_meeting', 'deadline'];

function formatSnapshot(row: ReportSnapshotRow): ReportSnapshot {
  return {
    id: row.id,
    reportType: row.reportType,
    title: row.title,
    payload: row.payload,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

async function countBy(column: typeof cases.status | typeof cases.practiceArea) {
  const rows = await db()
    .select({ key: column, value: sql<number>`count(*)::int` })
    .from(cases)
    .groupBy(column);
  return Object.fromEntries(rows.map((row) => [row.key, row.value])) as Record<string, number>;
}

export async function buildDashboard(): Promise<PracticeDashboard> {
  const [
    summary,
    openTasks,
    overdueInvoices,
    unreadNotifications,
    hearings,
    auditEvents,
    casesByStatus,
    casesByPracticeArea,
  ] = await Promise.all([
    intakeService.getSummary(),
    caseService.countOpenTasks(),
    billingService.countUnpaidInvoices(),
    notificationsService.unreadCount(),
    db()
      .select({ value: sql<number>`count(*)::int` })
      .from(calendarEvents)
      .where(inArray(calendarEvents.eventType, HEARING_TYPES)),
    auditService.countEvents(),
    countBy(cases.status),
    countBy(cases.practiceArea),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    summary,
    caseCount: summary.liveCases,
    criticalCases: summary.criticalMatters,
    openTasks,
    overdueInvoices,
    unreadNotifications,
    upcomingHearings: hearings[0]?.value ?? 0,
    auditEvents,
    casesByStatus,
    casesByPracticeArea,
  };
}

export async function generateSnapshot(input: unknown, actor: Actor = {}): Promise<ReportSnapshot> {
  const { title, reportType } = parse(reportSchema, input);
  const payload = await buildDashboard();

  const [saved] = await db()
    .insert(reportSnapshots)
    .values({
      reportType,
      title,
      payload: payload as unknown as Record<string, unknown>,
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Report snapshot was not stored');
  }

  await auditService.logEventSafely(
    {
      entityType: 'report',
      entityId: saved.id,
      action: 'report_generated',
      summary: 'Report generated',
    },
    actor,
  );

  return formatSnapshot(saved);
}

export async function listSnapshots(limit = 100): Promise<ReportSnapshot[]> {
  const rows = await db()
    .select()
    .from(reportSnapshots)
    .orderBy(desc(reportSnapshots.createdAt))
    .limit(limit);
  return rows.map(formatSnapshot);
}
