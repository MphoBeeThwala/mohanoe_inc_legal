const billingService = require('../services/billing.service');

async function summary(req, res) {
  try {
    const data = await billingService.getBillingSummary();
    res.status(200).json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function listInvoices(req, res) {
  try {
    const invoices = await billingService.listInvoices();
    res.status(200).json(invoices);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function createInvoice(req, res) {
  try {
    const invoice = await billingService.createInvoice(req.body, req.auth);
    res.status(201).json(invoice);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function listLedger(req, res) {
  try {
    const ledger = await billingService.listLedgerEntries();
    res.status(200).json(ledger);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

async function createLedger(req, res) {
  try {
    const entry = await billingService.recordLedgerEntry(req.body, req.auth);
    res.status(201).json(entry);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
}

module.exports = {
  createInvoice,
  createLedger,
  listInvoices,
  listLedger,
  summary,
};
