const express = require('express');
const billingController = require('../controllers/billing.controller');
const { authenticateRequest, requireRoles } = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/summary', billingController.summary);
router.get('/invoices', billingController.listInvoices);
router.post('/invoices', billingController.createInvoice);
router.get('/ledger', billingController.listLedger);
router.post('/ledger', billingController.createLedger);

module.exports = router;
