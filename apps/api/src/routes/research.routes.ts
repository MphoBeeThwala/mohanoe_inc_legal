import express, { type Request, type Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as research from '../services/research.service';
import * as ai from '../services/ai.service';

const router = express.Router();

const handle =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response) => {
    try {
      const result = await fn(req);
      if (result === undefined) {
        res.status(204).end();
      } else {
        res.status(status).json(result);
      }
    } catch (error) {
      sendError(res, error);
    }
  };

// Mounted at /api: each route authenticates itself so other paths pass through.
// The firm's AI usage this month (administrators).
router.get(
  '/ai/usage',
  authenticateRequest,
  requirePermission('users.manage'),
  handle(() => ai.usage()),
);

router.get(
  '/cases/:caseId/research',
  authenticateRequest,
  requirePermission('research.use', 'matters.read'),
  handle((req) => research.listForMatter(String(req.params.caseId))),
);
router.post(
  '/cases/:caseId/research',
  authenticateRequest,
  requirePermission('research.use', 'matters.read'),
  handle((req) => research.createDraft(String(req.params.caseId), req.body, req.auth ?? {}), 201),
);
router.get(
  '/research/:id',
  authenticateRequest,
  requirePermission('research.use'),
  handle((req) => research.getRequest(String(req.params.id))),
);
router.patch(
  '/research/:id',
  authenticateRequest,
  requirePermission('research.use'),
  handle((req) => research.updateBrief(String(req.params.id), req.body, req.auth ?? {})),
);
router.post(
  '/research/:id/confirm',
  authenticateRequest,
  requirePermission('research.use'),
  handle((req) => research.confirmBrief(String(req.params.id), req.auth ?? {})),
);
router.delete(
  '/research/:id',
  authenticateRequest,
  requirePermission('research.use'),
  handle(async (req) => {
    await research.deleteDraft(String(req.params.id), req.auth ?? {});
    return undefined;
  }),
);

export default router;
