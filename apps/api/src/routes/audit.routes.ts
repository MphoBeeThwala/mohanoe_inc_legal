import express from 'express';
import * as auditController from '../controllers/audit.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/', requirePermission('audit.read'), auditController.index);
router.get('/verify', requirePermission('audit.read'), auditController.verify);

export default router;
