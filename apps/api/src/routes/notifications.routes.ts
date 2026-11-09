import express from 'express';
import * as notificationsController from '../controllers/notifications.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/', requirePermission('notifications.read'), notificationsController.index);
router.get('/unread', requirePermission('notifications.read'), notificationsController.unread);
router.post('/', requirePermission('notifications.write'), notificationsController.create);
router.post(
  '/:notificationId/read',
  requirePermission('notifications.read'),
  notificationsController.markRead,
);

export default router;
