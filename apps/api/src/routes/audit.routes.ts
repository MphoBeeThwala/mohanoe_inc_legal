import express from 'express';
import * as auditController from '../controllers/audit.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', auditController.index);
router.get('/verify', requireRoles('admin'), auditController.verify);

export default router;
