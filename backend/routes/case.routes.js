const express = require('express');
const caseController = require('../controllers/case.controller');
const {
  authenticateRequest,
  requireRoles,
} = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', caseController.index);
router.get('/:caseId', caseController.show);
router.post('/:caseId/tasks', caseController.addTask);
router.post('/:caseId/tasks/:taskId/complete', caseController.completeTask);
router.post('/:caseId/status', caseController.updateStatus);
router.post('/:caseId/timeline', caseController.addTimeline);

module.exports = router;
