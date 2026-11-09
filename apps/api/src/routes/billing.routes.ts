// Billing: invoices (draft → issued → paid, or void), payments, PDFs and
// email, disbursements, client statements, aging and the ledger.
import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as billingService from '../services/billing.service';

type Handler = (req: Request) => Promise<unknown>;

function handle(fn: Handler, status = 200) {
  return async (req: Request, res: Response) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error) {
      sendError(res, error);
    }
  };
}

function pdf(fn: (req: Request) => Promise<billingService.RenderedPdf>) {
  return async (req: Request, res: Response) => {
    try {
      const { fileName, content } = await fn(req);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${fileName.replace(/[^\w.-]/g, '_')}"`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(content);
    } catch (error) {
      sendError(res, error);
    }
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pick = (req: Request, name: string, pattern: RegExp) => {
  const value = req.query[name];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
};
const id = (req: Request) => String(req.params.id);
const range = (req: Request) => ({ from: pick(req, 'from', DATE), to: pick(req, 'to', DATE) });

const router = express.Router();
router.use(authenticateRequest);

const read = requirePermission('billing.read');
const write = requirePermission('billing.write');
const voids = requirePermission('billing.void');

router.get(
  '/summary',
  read,
  handle(() => billingService.getBillingSummary()),
);

router.get(
  '/invoices',
  read,
  handle((req) =>
    billingService.listInvoices({
      caseId: pick(req, 'caseId', UUID),
      clientPartyId: pick(req, 'clientId', UUID),
      status: pick(req, 'status', /^(draft|issued|partially_paid|paid|void)$/),
    }),
  ),
);
router.post(
  '/invoices',
  write,
  handle((req) => billingService.createDraft(req.body, req.auth), 201),
);
router.get(
  '/invoices/:id',
  read,
  handle((req) => billingService.getInvoice(id(req))),
);
router.patch(
  '/invoices/:id',
  write,
  handle((req) => billingService.updateDraft(id(req), req.body, req.auth)),
);
router.delete(
  '/invoices/:id',
  write,
  handle((req) => billingService.deleteDraft(id(req), req.auth)),
);
router.post(
  '/invoices/:id/issue',
  write,
  handle((req) => billingService.issueInvoice(id(req), req.auth)),
);
router.post(
  '/invoices/:id/void',
  voids,
  handle((req) => billingService.voidInvoice(id(req), req.auth)),
);
router.get(
  '/invoices/:id/pdf',
  read,
  pdf((req) => billingService.invoiceDocument(id(req), req.auth)),
);
router.post(
  '/invoices/:id/send',
  write,
  handle((req) => billingService.sendInvoice(id(req), req.body, req.auth)),
);
router.post(
  '/invoices/:id/payments',
  write,
  handle((req) => billingService.recordPayment(id(req), req.body, req.auth), 201),
);
router.delete(
  '/invoices/:id/payments/:paymentId',
  voids,
  handle((req) => billingService.reversePayment(id(req), String(req.params.paymentId), req.auth)),
);

router.get(
  '/disbursements',
  read,
  handle((req) =>
    billingService.listDisbursements({
      caseId: pick(req, 'caseId', UUID),
      status: pick(req, 'status', /^(unbilled|billed|written_off)$/),
    }),
  ),
);
router.post(
  '/disbursements',
  write,
  handle((req) => billingService.recordDisbursement(req.body, req.auth), 201),
);
router.delete(
  '/disbursements/:id',
  write,
  handle((req) => billingService.deleteDisbursement(id(req), req.auth)),
);
router.post(
  '/disbursements/:id/write-off',
  voids,
  handle((req) => billingService.writeOffDisbursement(id(req), req.auth)),
);

router.get(
  '/aging',
  read,
  handle((req) => billingService.agingReport(pick(req, 'asOf', DATE))),
);
router.get(
  '/statements/:id',
  read,
  handle((req) => billingService.clientStatement(id(req), range(req))),
);
router.get(
  '/statements/:id/pdf',
  read,
  pdf((req) => billingService.statementDocument(id(req), range(req))),
);

router.get(
  '/ledger',
  read,
  handle(() => billingService.listLedgerEntries()),
);
router.post(
  '/ledger',
  write,
  handle((req) => billingService.recordLedgerEntry(req.body, req.auth), 201),
);

export default router;
