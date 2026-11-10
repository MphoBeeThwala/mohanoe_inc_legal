// Court roll listings found for the firm's matters, and uploading a roll.
import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as courtRollService from '../services/court-roll.service';
import * as courtService from '../services/court.service';

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

// Who else gets every court roll notice (e.g. the office manager).
router.get(
  '/watchers',
  requirePermission('calendar.read'),
  handle(() => courtService.rollWatchers()),
);
router.put(
  '/watchers',
  requirePermission('users.manage'),
  handle((req) => courtService.setRollWatchers(req.body, req.auth ?? {})),
);
router.get(
  '/court-online',
  requirePermission('calendar.read'),
  handle(() => courtService.listCourtOnlineCourts()),
);

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
