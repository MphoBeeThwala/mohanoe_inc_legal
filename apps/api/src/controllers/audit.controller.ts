import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as auditService from '../services/audit.service';

async function index(req: Request, res: Response) {
  try {
    const events = await auditService.listEvents({
      entityType: req.query.entityType,
      entityId: req.query.entityId,
    });
    res.status(200).json(events);
  } catch (error) {
    sendError(res, error);
  }
}

async function verify(req: Request, res: Response) {
  try {
    const status = await auditService.verifyEventChain();
    res.status(200).json(status);
  } catch (error) {
    sendError(res, error);
  }
}

export { index, verify };
