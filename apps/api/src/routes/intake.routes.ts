import express from 'express';
import * as intakeController from '../controllers/intake.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/summary', requirePermission('intake.read'), intakeController.getSummary);
router.get('/submissions', requirePermission('intake.read'), intakeController.listSubmissions);
router.post('/submissions', requirePermission('intake.write'), intakeController.createSubmission);
router.get('/submissions/:id', requirePermission('intake.read'), intakeController.getSubmission);
router.post(
  '/submissions/:id/assess',
  requirePermission('intake.write'),
  intakeController.assessSubmission,
);
router.get('/cases', requirePermission('matters.read'), intakeController.listCases);

export default router;
