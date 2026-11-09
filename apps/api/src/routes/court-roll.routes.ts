// Court roll listings found for the firm's matters, and uploading a roll.
import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as courtRollService from '../services/court-roll.service';

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

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const id = (req: Request) => String(req.params.id);

const router = express.Router();
router.use(authenticateRequest);

router.get(
  '/matches',
  requirePermission('calendar.read'),
  handle((req) =>
    courtRollService.listMatches({
      status: text(req.query.status)?.match(/^(new|accepted|dismissed|removed|all)$/)?.[0],
      caseId: text(req.query.caseId),
    }),
  ),
);
router.post(
  '/matches/:id/accept',
  requirePermission('calendar.write'),
  handle((req) => courtRollService.acceptMatch(id(req), req.body, req.auth)),
);
router.post(
  '/matches/:id/dismiss',
  requirePermission('calendar.write'),
  handle((req) => courtRollService.dismissMatch(id(req), req.auth)),
);
router.post(
  '/upload',
  requirePermission('calendar.write'),
  handle((req) => courtRollService.uploadRoll(req.body, req.auth)),
);

export default router;
