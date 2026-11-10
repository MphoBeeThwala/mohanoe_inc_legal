import express, { type Request, type Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as trust from '../services/trust.service';

const router = express.Router();

const handle =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error) {
      sendError(res, error);
    }
  };

const actor = (req: Request) => req.auth ?? {};
const id = (req: Request) => String(req.params.id);

router.use(authenticateRequest);

const read = requirePermission('trust.read');
const record = requirePermission('trust.record');
const authorise = requirePermission('trust.authorise');

router.get(
  '/status',
  read,
  handle(async () => ({ enabled: trust.trustEnabled() })),
);
router.get(
  '/accounts',
  read,
  handle(() => trust.listAccounts()),
);
router.post(
  '/accounts',
  authorise,
  handle((req) => trust.createAccount(req.body, actor(req)), 201),
);
router.get(
  '/accounts/:id/balances',
  read,
  handle((req) =>
    trust.balances(id(req), typeof req.query.asAt === 'string' ? req.query.asAt : undefined),
  ),
);
router.get(
  '/accounts/:id/ledger',
  read,
  handle((req) => trust.ledger(id(req), String(req.query.matter ?? ''))),
);
router.get(
  '/accounts/:id/reconciliations',
  read,
  handle((req) => trust.reconciliations(id(req))),
);
router.post(
  '/accounts/:id/reconciliations',
  record,
  handle((req) => trust.reconcile(id(req), req.body, actor(req)), 201),
);
router.get('/accounts/:id/cashbook.csv', authorise, async (req, res) => {
  try {
    const csv = await trust.cashbookCsv(
      id(req),
      String(req.query.from ?? ''),
      String(req.query.to ?? ''),
    );
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="trust-cashbook.csv"');
    res.send(csv);
  } catch (error) {
    sendError(res, error);
  }
});

router.post(
  '/receipts',
  record,
  handle((req) => trust.recordReceipt(req.body, actor(req)), 201),
);
router.post(
  '/payments',
  record,
  handle((req) => trust.requestPayment(req.body, actor(req)), 201),
);
router.post(
  '/fee-transfers',
  record,
  handle((req) => trust.requestFeeTransfer(req.body, actor(req)), 201),
);
router.post(
  '/transfers',
  record,
  handle((req) => trust.requestMatterTransfer(req.body, actor(req)), 201),
);
router.post(
  '/opening-balances',
  record,
  handle((req) => trust.requestCredit('opening_balance', req.body, actor(req)), 201),
);
router.post(
  '/interest',
  record,
  handle((req) => trust.requestCredit('interest', req.body, actor(req)), 201),
);
router.post(
  '/clear',
  record,
  handle(async (req) => ({ cleared: await trust.markCleared(req.body, actor(req)) })),
);

router.get(
  '/pending',
  read,
  handle(() => trust.pending()),
);
router.post(
  '/entries/:id/reverse',
  record,
  handle((req) => trust.requestReversal(id(req), req.body, actor(req)), 201),
);
router.post(
  '/entries/:id/authorise',
  authorise,
  handle((req) => trust.authorise(id(req), actor(req))),
);
router.post(
  '/entries/:id/reject',
  authorise,
  handle((req) => trust.reject(id(req), req.body, actor(req))),
);
router.post(
  '/reconciliations/:id/sign-off',
  authorise,
  handle((req) => trust.signOff(id(req), req.body, actor(req))),
);

export default router;
