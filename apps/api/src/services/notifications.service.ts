// In-app notifications for staff.

import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import type { NotificationRecord } from '@ahava88/shared';
import { db } from '../db/client';
import { notifications, type NotificationRow } from '../db/schema';
import { httpError } from '../lib/http';
import { actorName, type Actor } from '../lib/actor';
import { iso, isoOrNull } from '../lib/time';
import { notificationSchema, parse } from '../validation/schemas';
import * as auditService from './audit.service';

function formatNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    priority: row.priority,
    recipientRole: row.recipientRole,
    recipientUserId: row.recipientUserId,
    relatedEntityType: row.relatedEntityType,
    relatedEntityId: row.relatedEntityId,
    isRead: row.isRead,
    readAt: isoOrNull(row.readAt),
    createdAt: iso(row.createdAt),
  };
}

export interface NotificationFilters {
  recipientRole?: string;
  isRead?: boolean;
}

function filterConditions(filters: NotificationFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.recipientRole) {
    conditions.push(eq(notifications.recipientRole, filters.recipientRole));
  }
  if (typeof filters.isRead === 'boolean') {
    conditions.push(eq(notifications.isRead, filters.isRead));
  }
  return conditions.length ? and(...conditions) : undefined;
}

export async function listNotifications(
  filters: NotificationFilters = {},
  limit = 200,
): Promise<NotificationRecord[]> {
  const rows = await db()
    .select()
    .from(notifications)
    .where(filterConditions(filters))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows.map(formatNotification);
}

export async function unreadCount(recipientRole: string | null = null): Promise<number> {
  const [row] = await db()
    .select({ value: count() })
    .from(notifications)
    .where(filterConditions({ recipientRole: recipientRole ?? undefined, isRead: false }));
  return row?.value ?? 0;
}

export async function createNotification(
  input: unknown,
  actor: Actor = {},
): Promise<NotificationRecord> {
  const notification = parse(notificationSchema, input);
  const [saved] = await db()
    .insert(notifications)
    .values({
      title: notification.title,
      body: notification.body,
      category: notification.category,
      priority: notification.priority,
      recipientRole: notification.recipientRole,
      recipientUserId: notification.recipientUserId ?? null,
      relatedEntityType: notification.relatedEntityType ?? null,
      relatedEntityId: notification.relatedEntityId ?? null,
      createdBy: actorName(actor),
    })
    .returning();
  if (!saved) {
    throw new Error('Notification was not stored');
  }

  await auditService.logEventSafely(
    {
      entityType: 'notification',
      entityId: saved.id,
      action: 'notification_created',
      summary: `Notification created (${saved.category})`,
      details: { category: saved.category, recipientRole: saved.recipientRole },
    },
    actor,
  );

  return formatNotification(saved);
}

export async function markRead(
  notificationId: string,
  actor: Actor = {},
): Promise<NotificationRecord> {
  const [updated] = await db()
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(eq(notifications.id, notificationId))
    .returning();
  if (!updated) {
    throw httpError('Notification not found', 404);
  }

  await auditService.logEventSafely(
    {
      entityType: 'notification',
      entityId: notificationId,
      action: 'notification_read',
      summary: 'Notification read',
    },
    actor,
  );

  return formatNotification(updated);
}
