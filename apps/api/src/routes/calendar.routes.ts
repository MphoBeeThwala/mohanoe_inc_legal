import express from 'express';
import * as calendarController from '../controllers/calendar.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', calendarController.index);
router.get('/upcoming', calendarController.upcoming);
router.post('/', calendarController.create);

export default router;
