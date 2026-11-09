import express from 'express';
import * as billingController from '../controllers/billing.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/summary', requirePermission('billing.read'), billingController.summary);
router.get('/invoices', requirePermission('billing.read'), billingController.listInvoices);
router.post('/invoices', requirePermission('billing.write'), billingController.createInvoice);
router.get('/ledger', requirePermission('billing.read'), billingController.listLedger);
router.post('/ledger', requirePermission('billing.write'), billingController.createLedger);

export default router;
