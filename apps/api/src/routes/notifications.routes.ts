import express from 'express';
import * as notificationsController from '../controllers/notifications.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', notificationsController.index);
router.get('/unread', notificationsController.unread);
router.post('/', notificationsController.create);
router.post('/:notificationId/read', notificationsController.markRead);

export default router;
