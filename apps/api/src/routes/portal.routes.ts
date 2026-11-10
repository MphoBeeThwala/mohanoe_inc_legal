// The client portal API (/api/portal). Not staff routes: a portal session
// (portal.service requirePortalUser) is the only way in.
import express, { type Request, type Response } from 'express';
import { sendError } from '../lib/http';
import { createRateLimiter } from '../middleware/security';
import * as portal from '../services/portal.service';
import type { PortalUserRow } from '../db/schema';

const router = express.Router();

// Sign-in steps: tight limits (codes are 6 digits).
const signInLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
});

const open =
  (fn: (req: Request, res: Response) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response) => {
    try {
      const result = await fn(req, res);
      if (result === undefined) res.status(204).end();
      else res.status(status).json(result);
    } catch (error) {
      sendError(res, error);
    }
  };

const client =
  (fn: (user: PortalUserRow, req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      res.setHeader('cache-control', 'no-store');
      res.json(await fn(await portal.requirePortalUser(req), req));
    } catch (error) {
      sendError(res, error);
    }
  };

router.post(
  '/invite/start',
  signInLimiter,
  open((req) => portal.beginEnrolment(String(req.body?.token ?? ''))),
);
router.post(
  '/invite/complete',
  signInLimiter,
  open((req, res) => portal.completeEnrolment(req.body, res)),
);
router.post(
  '/sign-in',
  signInLimiter,
  open(async (req) => {
    await portal.requestSignIn(req.body);
    return { sent: true };
  }),
);
router.post(
  '/sign-in/complete',
  signInLimiter,
  open((req, res) => portal.completeSignIn(req.body, res)),
);
router.post(
  '/sign-out',
  open(async (req, res) => portal.signOut(req, res)),
);

router.get(
  '/me',
  client((user) => portal.me(user)),
);
router.get(
  '/matters',
  client((user) => portal.matters(user)),
);
router.get(
  '/documents',
  client((user) => portal.sharedDocuments(user)),
);
router.get(
  '/documents/:id',
  client((user, req) => portal.sharedDocument(user, String(req.params.id))),
);
router.get(
  '/invoices',
  client((user) => portal.clientInvoices(user)),
);
router.get(
  '/matters/:id/messages',
  client((user, req) => portal.clientMessages(user, String(req.params.id))),
);
router.post(
  '/matters/:id/messages',
  client((user, req) => portal.sendClientMessage(user, String(req.params.id), req.body)),
);
router.get(
  '/fica',
  client((user) => portal.clientFica(user)),
);
router.post(
  '/fica',
  client((user, req) => portal.uploadFica(user, req.body)),
);

export default router;
