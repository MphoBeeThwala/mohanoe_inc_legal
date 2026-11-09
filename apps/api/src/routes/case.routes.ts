import express from 'express';
import * as caseController from '../controllers/case.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/', requirePermission('matters.read'), caseController.index);
router.get('/:caseId', requirePermission('matters.read'), caseController.show);
router.post('/:caseId/tasks', requirePermission('matters.write'), caseController.addTask);
router.post(
  '/:caseId/tasks/:taskId/complete',
  requirePermission('matters.write'),
  caseController.completeTask,
);
router.post('/:caseId/status', requirePermission('matters.write'), caseController.updateStatus);
router.post('/:caseId/timeline', requirePermission('matters.write'), caseController.addTimeline);

// Matter access and ethical walls (admins and the matter's leads manage them).
router.get('/:caseId/access', requirePermission('matters.read'), caseController.getAccess);
router.put('/:caseId/access', requirePermission('matters.write'), caseController.setAccess);
router.post('/:caseId/members', requirePermission('matters.write'), caseController.addMember);
router.delete(
  '/:caseId/members/:userId',
  requirePermission('matters.write'),
  caseController.removeMember,
);
router.post('/:caseId/exclusions', requirePermission('matters.write'), caseController.addExclusion);
router.delete(
  '/:caseId/exclusions/:userId',
  requirePermission('matters.write'),
  caseController.removeExclusion,
);

export default router;
