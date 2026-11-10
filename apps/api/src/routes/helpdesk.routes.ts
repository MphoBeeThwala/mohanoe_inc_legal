// Help centre and support requests, for the firm's staff.
import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as helpdesk from '../services/helpdesk.service';

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

router.use(authenticateRequest, requirePermission('helpdesk.use'));

router.get(
  '/',
  handle(() => helpdesk.helpCentre()),
);
router.get(
  '/articles/:slug',
  handle((req) => helpdesk.article(String(req.params.slug))),
);
router.get(
  '/tickets',
  handle((req) => helpdesk.listTickets(req.auth ?? {})),
);
router.post(
  '/tickets',
  handle((req) => helpdesk.createTicket(req.body, req.auth ?? {}), 201),
);
router.get(
  '/tickets/:id',
  handle((req) => helpdesk.getTicket(String(req.params.id), req.auth ?? {})),
);
router.post(
  '/tickets/:id/messages',
  handle((req) => helpdesk.replyAsStaff(String(req.params.id), req.body, req.auth ?? {})),
);
router.post(
  '/tickets/:id/close',
  handle((req) => helpdesk.closeTicket(String(req.params.id), req.auth ?? {})),
);

export default router;
