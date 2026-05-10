const express = require('express');
const intakeController = require('../controllers/intake.controller');
const {
  authenticateRequest,
  requireRoles,
} = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/summary', intakeController.getSummary);
router.get('/submissions', intakeController.listSubmissions);
router.post('/submissions', intakeController.createSubmission);
router.get('/submissions/:id', intakeController.getSubmission);
router.post('/submissions/:id/assess', intakeController.assessSubmission);
router.get('/cases', intakeController.listCases);

module.exports = router;
