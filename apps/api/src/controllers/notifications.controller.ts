import { notificationFilterSchema, parse } from '../validation/schemas';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as notificationsService from '../services/notifications.service';

async function index(req: Request, res: Response) {
  try {
    const notifications = await notificationsService.listNotifications(
      parse(notificationFilterSchema, req.query),
    );
    res.status(200).json(notifications);
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req: Request, res: Response) {
  try {
    const notification = await notificationsService.createNotification(req.body, req.auth);
    res.status(201).json(notification);
  } catch (error) {
    sendError(res, error);
  }
}

async function markRead(req: Request, res: Response) {
  try {
    const notification = await notificationsService.markRead(
      String(req.params.notificationId),
      req.auth,
    );
    res.status(200).json(notification);
  } catch (error) {
    sendError(res, error);
  }
}

async function unread(req: Request, res: Response) {
  try {
    const count = await notificationsService.unreadCount(
      typeof req.query.recipientRole === 'string' ? req.query.recipientRole : null,
    );
    res.status(200).json({ count });
  } catch (error) {
    sendError(res, error);
  }
}

export { create, index, markRead, unread };
