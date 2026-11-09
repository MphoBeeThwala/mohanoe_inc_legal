import express from 'express';
import * as complianceController from '../controllers/compliance.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/summary', complianceController.summary);
router.get('/requests', complianceController.index);
router.post('/requests', complianceController.create);
router.post('/requests/:requestId/fulfill', requireRoles('admin'), complianceController.fulfill);
router.get('/export', requireRoles('admin'), complianceController.exportData);
router.post('/retention/sweep', requireRoles('admin'), complianceController.retentionSweep);

export default router;
