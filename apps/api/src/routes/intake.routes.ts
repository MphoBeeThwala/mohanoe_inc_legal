import express from 'express';
import * as intakeController from '../controllers/intake.controller';
import {
  authenticateRequest,
  requireRoles,
} from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/summary', intakeController.getSummary);
router.get('/submissions', intakeController.listSubmissions);
router.post('/submissions', intakeController.createSubmission);
router.get('/submissions/:id', intakeController.getSubmission);
router.post('/submissions/:id/assess', intakeController.assessSubmission);
router.get('/cases', intakeController.listCases);

export default router;
