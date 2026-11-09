import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as partyService from '../services/party.service';
import * as clientsService from '../services/clients.service';
import * as conflictService from '../services/conflict.service';
import * as ficaService from '../services/fica.service';

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

const query = (req: Request) => (typeof req.query.q === 'string' ? req.query.q : undefined);

// ---------------------------------------------------------------- clients
export const clients = express.Router();
clients.use(authenticateRequest);
clients.get(
  '/',
  requirePermission('clients.read'),
  handle((req) => partyService.searchParties(query(req), { clientsOnly: true })),
);
clients.post(
  '/',
  requirePermission('clients.write'),
  handle((req) => clientsService.createClient(req.body, req.auth ?? {}), 201),
);
clients.get(
  '/:partyId',
  requirePermission('clients.read'),
  handle((req) => partyService.getParty(String(req.params.partyId))),
);
clients.patch(
  '/:partyId',
  requirePermission('clients.write'),
  handle((req) => partyService.updateParty(String(req.params.partyId), req.body, req.auth ?? {})),
);
clients.post(
  '/:partyId/convert',
  requirePermission('clients.write'),
  handle((req) =>
    clientsService.convertToClient(
      String(req.params.partyId),
      String((req.body as { conflictCheckId?: string })?.conflictCheckId ?? ''),
      req.auth ?? {},
    ),
  ),
);

// FICA customer due diligence for a client.
clients.get(
  '/:partyId/fica',
  requirePermission('fica.read'),
  handle((req) => ficaService.getProfile(String(req.params.partyId))),
);
clients.put(
  '/:partyId/fica/risk',
  requirePermission('fica.write'),
  handle((req) => ficaService.assessRisk(String(req.params.partyId), req.body, req.auth ?? {})),
);
clients.post(
  '/:partyId/fica/documents',
  requirePermission('fica.write'),
  handle(
    (req) => ficaService.uploadDocument(String(req.params.partyId), req.body, req.auth ?? {}),
    201,
  ),
);
clients.get(
  '/:partyId/fica/documents/:documentId',
  requirePermission('fica.read'),
  async (req: Request, res: Response) => {
    try {
      const file = await ficaService.downloadDocument(
        String(req.params.partyId),
        String(req.params.documentId),
        req.auth ?? {},
      );
      res.setHeader('Content-Type', file.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      );
      res.status(200).end(file.bytes);
    } catch (error) {
      sendError(res, error);
    }
  },
);
clients.delete(
  '/:partyId/fica/documents/:documentId',
  requirePermission('fica.write'),
  handle((req) =>
    ficaService.deleteDocument(
      String(req.params.partyId),
      String(req.params.documentId),
      req.auth ?? {},
    ),
  ),
);
clients.post(
  '/:partyId/fica/verify',
  requirePermission('fica.verify'),
  handle((req) => ficaService.verify(String(req.params.partyId), req.auth ?? {})),
);

// ---------------------------------------------------------------- all parties
export const partiesRouter = express.Router();
partiesRouter.use(authenticateRequest);
partiesRouter.get(
  '/',
  requirePermission('clients.read'),
  handle((req) => partyService.searchParties(query(req))),
);
partiesRouter.post(
  '/',
  requirePermission('clients.write'),
  handle(async (req) => {
    const saved = await partyService.createParty(req.body, req.auth ?? {});
    return partyService.getParty(saved.id);
  }, 201),
);

// ---------------------------------------------------------------- conflict checks
export const conflicts = express.Router();
conflicts.use(authenticateRequest, requirePermission('conflicts.check'));
conflicts.get(
  '/',
  handle(() => conflictService.listChecks()),
);
conflicts.post(
  '/',
  handle((req) => conflictService.runCheck(req.body, req.auth ?? {}), 201),
);
conflicts.get(
  '/:checkId',
  handle((req) => conflictService.getCheck(String(req.params.checkId))),
);
conflicts.post(
  '/:checkId/decision',
  handle((req) => conflictService.decide(String(req.params.checkId), req.body, req.auth ?? {})),
);
