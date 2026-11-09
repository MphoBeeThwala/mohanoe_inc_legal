import express from 'express';
import * as billingController from '../controllers/billing.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/summary', billingController.summary);
router.get('/invoices', billingController.listInvoices);
router.post('/invoices', billingController.createInvoice);
router.get('/ledger', billingController.listLedger);
router.post('/ledger', billingController.createLedger);

export default router;
