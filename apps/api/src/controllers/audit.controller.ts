import { auditFilterSchema, parse } from '../validation/schemas';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as auditService from '../services/audit.service';
import { verifyAuditTrail } from '../services/audit-anchor.service';

async function index(req: Request, res: Response) {
  try {
    const events = await auditService.listEvents(parse(auditFilterSchema, req.query));
    res.status(200).json(events);
  } catch (error) {
    sendError(res, error);
  }
}

async function verify(req: Request, res: Response) {
  try {
    const status = await verifyAuditTrail();
    res.status(200).json(status);
  } catch (error) {
    sendError(res, error);
  }
}

export { index, verify };
