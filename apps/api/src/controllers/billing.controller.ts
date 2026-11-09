import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as billingService from '../services/billing.service';

async function summary(req: Request, res: Response) {
  try {
    const data = await billingService.getBillingSummary();
    res.status(200).json(data);
  } catch (error) {
    sendError(res, error);
  }
}

async function listInvoices(req: Request, res: Response) {
  try {
    const invoices = await billingService.listInvoices();
    res.status(200).json(invoices);
  } catch (error) {
    sendError(res, error);
  }
}

async function createInvoice(req: Request, res: Response) {
  try {
    const invoice = await billingService.createInvoice(req.body, req.auth);
    res.status(201).json(invoice);
  } catch (error) {
    sendError(res, error);
  }
}

async function listLedger(req: Request, res: Response) {
  try {
    const ledger = await billingService.listLedgerEntries();
    res.status(200).json(ledger);
  } catch (error) {
    sendError(res, error);
  }
}

async function createLedger(req: Request, res: Response) {
  try {
    const entry = await billingService.recordLedgerEntry(req.body, req.auth);
    res.status(201).json(entry);
  } catch (error) {
    sendError(res, error);
  }
}

export {
  createInvoice,
  createLedger,
  listInvoices,
  listLedger,
  summary,
};
