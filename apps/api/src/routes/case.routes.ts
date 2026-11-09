import express from 'express';
import * as caseController from '../controllers/case.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', caseController.index);
router.get('/:caseId', caseController.show);
router.post('/:caseId/tasks', caseController.addTask);
router.post('/:caseId/tasks/:taskId/complete', caseController.completeTask);
router.post('/:caseId/status', caseController.updateStatus);
router.post('/:caseId/timeline', caseController.addTimeline);

export default router;
