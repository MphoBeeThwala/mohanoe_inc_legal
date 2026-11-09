import express from 'express';
import * as calendarController from '../controllers/calendar.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/', requirePermission('calendar.read'), calendarController.index);
router.get('/upcoming', requirePermission('calendar.read'), calendarController.upcoming);
router.post('/', requirePermission('calendar.write'), calendarController.create);

export default router;
