const { randomUUID } = require('crypto');
const { getSupabaseClient } = require('../config/supabase');
const auditService = require('./audit.service');

const memory = {
  notifications: [],
};

function toIso(value = new Date()) {
  return new Date(value).toISOString();
}

async function listRows() {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      throw error;
    }

    return data || [];
  }

  return [...memory.notifications].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function saveRow(record) {
  const db = getSupabaseClient();
  if (db) {
    const { data, error } = await db.from('notifications').insert(record).select().single();
    if (error) {
      throw error;
    }

    return data;
  }

  memory.notifications.unshift(record);
  return record;
}

function formatNotification(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    priority: row.priority,
    recipientRole: row.recipient_role,
    recipientUserId: row.recipient_user_id,
    relatedEntityType: row.related_entity_type,
    relatedEntityId: row.related_entity_id,
    isRead: row.is_read,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

async function listNotifications(filters = {}) {
  const rows = await listRows();
  return rows
    .filter((row) => {
      if (filters.recipientRole && row.recipient_role !== filters.recipientRole) {
        return false;
      }

      if (typeof filters.isRead === 'boolean' && Boolean(row.is_read) !== filters.isRead) {
        return false;
      }

      return true;
    })
    .map(formatNotification);
}

async function unreadCount(recipientRole = null) {
  const rows = await listNotifications(
    recipientRole ? { recipientRole, isRead: false } : { isRead: false },
  );
  return rows.length;
}

async function createNotification(input = {}, actor = {}) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  const category = String(input.category || 'general').trim();
  const recipientRole = String(input.recipientRole || 'attorney').trim();

  if (!title || !body) {
    const error = new Error('title and body are required');
    error.statusCode = 400;
    throw error;
  }

  const record = {
    id: randomUUID(),
    title,
    body,
    category,
    priority: String(input.priority || 'medium').trim(),
    recipient_role: recipientRole,
    recipient_user_id: input.recipientUserId || null,
    related_entity_type: input.relatedEntityType || null,
    related_entity_id: input.relatedEntityId || null,
    is_read: false,
    read_at: null,
    created_by: actor?.fullName || actor?.email || 'system',
    created_at: toIso(),
  };

  const saved = await saveRow(record);
  await auditService
    .logEvent(
      {
        entityType: 'notification',
        entityId: saved.id,
        action: 'notification_created',
        summary: title,
        details: {
          category,
          recipientRole,
        },
      },
      actor,
    )
    .catch(() => {});

  return formatNotification(saved);
}

async function markRead(notificationId, actor = {}) {
  const rows = await listRows();
  const row = rows.find((item) => item.id === notificationId);
  if (!row) {
    const error = new Error('Notification not found');
    error.statusCode = 404;
    throw error;
  }

  const updated = {
    ...row,
    is_read: true,
    read_at: toIso(),
  };

  const db = getSupabaseClient();
  if (db) {
    const { error } = await db
      .from('notifications')
      .update({ is_read: true, read_at: updated.read_at })
      .eq('id', notificationId);
    if (error) {
      throw error;
    }
  } else {
    const index = memory.notifications.findIndex((item) => item.id === notificationId);
    if (index >= 0) {
      memory.notifications[index] = updated;
    }
  }

  await auditService
    .logEvent(
      {
        entityType: 'notification',
        entityId: notificationId,
        action: 'notification_read',
        summary: row.title,
      },
      actor,
    )
    .catch(() => {});

  return formatNotification(updated);
}

module.exports = {
  createNotification,
  listNotifications,
  markRead,
  unreadCount,
};
