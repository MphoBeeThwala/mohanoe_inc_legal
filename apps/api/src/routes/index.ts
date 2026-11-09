import express from 'express';
import authRoutes from './auth.routes';
import auditRoutes from './audit.routes';
import billingRoutes from './billing.routes';
import complianceRoutes from './compliance.routes';
import caseRoutes from './case.routes';
import calendarRoutes from './calendar.routes';
import documentsRoutes from './documents.routes';
import notificationsRoutes from './notifications.routes';
import reportsRoutes from './reports.routes';
import intakeRoutes from './intake.routes';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/audit', auditRoutes);
router.use('/billing', billingRoutes);
router.use('/compliance', complianceRoutes);
router.use('/cases', caseRoutes);
router.use('/calendar', calendarRoutes);
router.use('/documents', documentsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/reports', reportsRoutes);
router.use('/intake', intakeRoutes);

export default router;
