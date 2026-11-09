import express from 'express';
import * as complianceController from '../controllers/compliance.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import { fullFirmScope } from '../middleware/tenant';

const router = express.Router();

router.use(authenticateRequest);

router.get('/summary', requirePermission('compliance.read'), complianceController.summary);
router.get('/requests', requirePermission('compliance.read'), complianceController.index);
router.post('/requests', requirePermission('compliance.write'), complianceController.create);
router.post(
  '/requests/:requestId/fulfill',
  requirePermission('compliance.admin'),
  fullFirmScope,
  complianceController.fulfill,
);
router.get(
  '/export',
  requirePermission('compliance.admin'),
  fullFirmScope,
  complianceController.exportData,
);
router.post(
  '/retention/sweep',
  requirePermission('compliance.admin'),
  fullFirmScope,
  complianceController.retentionSweep,
);

export default router;
