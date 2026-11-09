import express from 'express';
import * as reportsController from '../controllers/reports.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/dashboard', requirePermission('reports.read'), reportsController.dashboard);
router.get('/', requirePermission('reports.read'), reportsController.index);
router.post('/', requirePermission('reports.read'), reportsController.generate);

export default router;
