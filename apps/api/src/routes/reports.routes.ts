import express from 'express';
import * as reportsController from '../controllers/reports.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/dashboard', reportsController.dashboard);
router.get('/', reportsController.index);
router.post('/', reportsController.generate);

export default router;
