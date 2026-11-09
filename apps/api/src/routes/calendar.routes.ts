// Calendar events, prescriptions and the iCalendar export.
import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as calendarService from '../services/calendar.service';
import * as prescriptionService from '../services/prescription.service';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const pick = (req: Request, name: string, pattern: RegExp) => {
  const value = req.query[name];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
};
const id = (req: Request) => String(req.params.id);

const router = express.Router();
router.use(authenticateRequest);

const read = requirePermission('calendar.read');
const write = requirePermission('calendar.write');

router.get(
  '/',
  read,
  handle((req) =>
    calendarService.listEvents({
      from: pick(req, 'from', DATE),
      to: pick(req, 'to', DATE),
      caseId: pick(req, 'caseId', UUID),
      assigneeUserId: req.query.mine === '1' ? req.auth?.userId : undefined,
      includeClosed: req.query.all === '1',
    }),
  ),
);
router.get(
  '/upcoming',
  read,
  handle(() => calendarService.getUpcomingEvents()),
);
router.get('/ics', read, async (req: Request, res: Response) => {
  try {
    const body = await calendarService.icsExport({
      assigneeUserId: req.query.mine === '1' ? req.auth?.userId : undefined,
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(body);
  } catch (error) {
    sendError(res, error);
  }
});
router.post(
  '/',
  write,
  handle((req) => calendarService.createEvent(req.body, req.auth), 201),
);

router.get(
  '/prescriptions',
  read,
  handle((req) => prescriptionService.listPrescriptions(pick(req, 'caseId', UUID))),
);
router.post(
  '/prescriptions',
  write,
  handle((req) => prescriptionService.createPrescription(req.body, req.auth), 201),
);
router.patch(
  '/prescriptions/:id',
  write,
  handle((req) => prescriptionService.updatePrescription(id(req), req.body, req.auth)),
);

router.get(
  '/:id',
  read,
  handle((req) => calendarService.getEvent(id(req))),
);
router.patch(
  '/:id',
  write,
  handle((req) => calendarService.updateEvent(id(req), req.body, req.auth)),
);
router.delete(
  '/:id',
  write,
  handle((req) => calendarService.deleteEvent(id(req), req.auth)),
);

export default router;
