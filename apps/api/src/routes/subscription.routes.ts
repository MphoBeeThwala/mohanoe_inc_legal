import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as subscriptions from '../services/subscription.service';
import * as invoices from '../services/platform-invoice.service';

const router = express.Router();

type Handler = (req: Request) => Promise<unknown>;
const handle =
  (fn: Handler, status = 200) =>
  async (req: Request, res: Response) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error) {
      sendError(res, error);
    }
  };

router.use(authenticateRequest);

// Everyone in the firm: trial days left, overdue, read-only mode.
router.get(
  '/banner',
  handle(() => subscriptions.banner()),
);

router.use(requirePermission('subscription.manage'));

router.get(
  '/',
  handle(() => subscriptions.getStatus()),
);
router.get(
  '/plans',
  handle(() => subscriptions.listPlans()),
);
router.post(
  '/checkout',
  handle((req) => subscriptions.startCheckout(req.body, req.auth ?? {}), 201),
);
router.patch(
  '/seats',
  handle((req) => subscriptions.changeSeats(req.body, req.auth ?? {})),
);
router.post(
  '/cancel',
  handle((req) => subscriptions.cancel(req.auth ?? {})),
);

// The platform's (tax) invoices for the firm's subscription payments.
router.get(
  '/invoices',
  handle(() => invoices.listForFirm()),
);
router.get('/invoices/:id/pdf', async (req: Request, res: Response) => {
  try {
    const { number, pdf } = await invoices.pdfForFirm(String(req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(pdf);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
