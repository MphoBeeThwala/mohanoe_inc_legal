const express = require('express');
const complianceController = require('../controllers/compliance.controller');
const { authenticateRequest, requireRoles } = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/summary', complianceController.summary);
router.get('/requests', complianceController.index);
router.post('/requests', complianceController.create);
router.post('/requests/:requestId/fulfill', complianceController.fulfill);
router.get('/export', complianceController.exportData);
router.post('/retention/sweep', requireRoles('admin'), complianceController.retentionSweep);

module.exports = router;
