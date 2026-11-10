import express, { type Request, type Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as research from '../services/research.service';
import * as ai from '../services/ai.service';
import * as corpus from '../services/corpus.service';
import * as precedents from '../services/precedent.service';

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
router.post(
  '/research/:id/run',
  authenticateRequest,
  requirePermission('research.use'),
  handle((req) => research.run(String(req.params.id), req.auth ?? {})),
);
router.post(
  '/research/:id/approve',
  authenticateRequest,
  requirePermission('research.approve'),
  handle((req) => research.approve(String(req.params.id), req.body, req.auth ?? {})),
);

// What research may draw on, and the firm's own precedents.
router.get(
  '/research-sources',
  authenticateRequest,
  requirePermission('research.use'),
  handle(() => corpus.approvedSources()),
);
router.get(
  '/precedents',
  authenticateRequest,
  requirePermission('research.use'),
  handle(() => precedents.list()),
);
router.post(
  '/precedents',
  authenticateRequest,
  requirePermission('research.use', 'documents.write'),
  handle((req) => precedents.upload(req.body, req.auth ?? {}), 201),
);
router.get(
  '/precedents/:id',
  authenticateRequest,
  requirePermission('research.use'),
  handle((req) => precedents.get(String(req.params.id))),
);
router.patch(
  '/precedents/:id',
  authenticateRequest,
  requirePermission('research.use', 'documents.write'),
  handle((req) => precedents.updateText(String(req.params.id), req.body, req.auth ?? {})),
);
router.post(
  '/precedents/:id/approve',
  authenticateRequest,
  requirePermission('research.approve'),
  handle((req) => precedents.approve(String(req.params.id), req.auth ?? {})),
);
router.delete(
  '/precedents/:id',
  authenticateRequest,
  requirePermission('research.approve'),
  handle(async (req) => {
    await precedents.remove(String(req.params.id), req.auth ?? {});
    return undefined;
  }),
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
