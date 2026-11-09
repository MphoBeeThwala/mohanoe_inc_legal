import express from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.get('/config', authController.config);
router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/me', authenticateRequest, authController.me);
router.post('/seed-admin', authenticateRequest, requireRoles('admin'), authController.seedAdmin);

export default router;
