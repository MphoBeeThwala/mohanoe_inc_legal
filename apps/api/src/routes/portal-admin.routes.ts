// Staff side of the portal: access, sharing, client updates and messages.
// Mounted at /api; each route authenticates itself.
import express, { type Request, type Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as portal from '../services/portal.service';

const router = express.Router();
const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    sendError(res, error);
  }
};
const id = (req: Request) => String(req.params.id);

router.get(
  '/clients/:id/portal',
  authenticateRequest,
  requirePermission('portal.manage'),
  handle(async (req) => ({ access: await portal.accessFor(id(req)) })),
);
router.post(
  '/clients/:id/portal/invite',
  authenticateRequest,
  requirePermission('portal.manage'),
  handle((req) => portal.invite(id(req), req.body, req.auth ?? {})),
);
router.post(
  '/portal-users/:id/disable',
  authenticateRequest,
  requirePermission('portal.manage'),
  handle((req) => portal.disable(id(req), req.auth ?? {})),
);
router.post(
  '/documents/:id/share',
  authenticateRequest,
  requirePermission('documents.write'),
  handle((req) => portal.shareDocument(id(req), req.body?.shared !== false, req.auth ?? {})),
);
router.put(
  '/cases/:id/client-update',
  authenticateRequest,
  requirePermission('matters.write'),
  handle((req) => portal.setClientUpdate(id(req), req.body, req.auth ?? {})),
);
router.get(
  '/cases/:id/portal-messages',
  authenticateRequest,
  requirePermission('portal.manage', 'matters.read'),
  handle((req) => portal.staffMessages(id(req))),
);
router.post(
  '/cases/:id/portal-messages',
  authenticateRequest,
  requirePermission('portal.manage', 'matters.read'),
  handle((req) => portal.sendStaffMessage(id(req), req.body, req.auth ?? {})),
);

export default router;
