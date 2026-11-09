// Time recording: entries, the signed-in fee earner's timer, WIP and rates.
import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as timeService from '../services/time.service';

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

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function timeQuery(req: Request): timeService.TimeQuery {
  const pick = (name: string, pattern: RegExp) => {
    const value = text(req.query[name]);
    return value && pattern.test(value) ? value : undefined;
  };
  const status = text(req.query.status);
  const limit = Number(req.query.limit);
  return {
    caseId: pick('caseId', UUID),
    userId: req.query.userId === 'me' ? req.auth?.userId : pick('userId', UUID),
    from: pick('from', DATE),
    to: pick('to', DATE),
    status: status && ['unbilled', 'billed', 'written_off'].includes(status) ? status : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

const router = express.Router();
router.use(authenticateRequest);

router.get(
  '/entries',
  requirePermission('time.read'),
  handle((req) => timeService.listEntries(timeQuery(req))),
);
router.post(
  '/entries',
  requirePermission('time.record'),
  handle((req) => timeService.recordTime(req.body, req.auth ?? {}), 201),
);
router.patch(
  '/entries/:id',
  requirePermission('time.record'),
  handle((req) => timeService.updateEntry(String(req.params.id), req.body, req.auth ?? {})),
);
router.delete(
  '/entries/:id',
  requirePermission('time.record'),
  handle((req) => timeService.deleteEntry(String(req.params.id), req.auth ?? {})),
);
router.post(
  '/entries/:id/write-off',
  requirePermission('time.manage'),
  handle((req) => timeService.writeOff(String(req.params.id), req.auth ?? {})),
);

router.get(
  '/wip',
  requirePermission('time.read'),
  handle(() => timeService.wip()),
);

router.get(
  '/timer',
  requirePermission('time.record'),
  handle(async (req) => ({ timer: await timeService.getTimer(req.auth ?? {}) })),
);
router.post(
  '/timer',
  requirePermission('time.record'),
  handle((req) => timeService.startTimer(req.body, req.auth ?? {}), 201),
);
router.post(
  '/timer/pause',
  requirePermission('time.record'),
  handle((req) => timeService.pauseTimer(req.auth ?? {})),
);
router.post(
  '/timer/resume',
  requirePermission('time.record'),
  handle((req) => timeService.resumeTimer(req.auth ?? {})),
);
router.post(
  '/timer/stop',
  requirePermission('time.record'),
  handle((req) => timeService.stopTimer(req.body, req.auth ?? {}), 201),
);
router.delete(
  '/timer',
  requirePermission('time.record'),
  handle((req) => timeService.discardTimer(req.auth ?? {})),
);

router.get(
  '/rates',
  requirePermission('time.read'),
  handle(() => timeService.listStaffRates()),
);
router.put(
  '/rates/:userId',
  requirePermission('rates.manage'),
  handle((req) => timeService.setStaffRate(String(req.params.userId), req.body, req.auth ?? {})),
);
router.get(
  '/matters/:caseId/rates',
  requirePermission('time.read'),
  handle((req) => timeService.listMatterRates(String(req.params.caseId))),
);
router.put(
  '/matters/:caseId/rates',
  requirePermission('rates.manage'),
  handle((req) => timeService.setMatterRate(String(req.params.caseId), req.body, req.auth ?? {})),
);

export default router;
