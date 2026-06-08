const express = require('express');
const notificationsController = require('../controllers/notifications.controller');
const { authenticateRequest, requireRoles } = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', notificationsController.index);
router.get('/unread', notificationsController.unread);
router.post('/', notificationsController.create);
router.post('/:notificationId/read', notificationsController.markRead);

module.exports = router;
