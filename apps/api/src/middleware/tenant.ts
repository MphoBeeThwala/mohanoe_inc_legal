// Tenant middleware for /api.
//
// 1. Resolves the firm from the request's host name (404 if none, 403 if the
//    firm is suspended).
// 2. Runs the rest of the request inside withTenant(): one transaction,
//    restricted role, app.firm_id set, so row-level security applies to every
//    query the request makes.
// 3. Holds the response until the transaction has committed, so a client
//    never sees "saved" for data another request can't read yet. Responses
//    with status >= 500 roll the transaction back.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RollbackSignal, elevateToSystem, withTenant } from '../db/tenant';
import { resolveFirmForHost } from '../services/firm.service';
import { errorMessage } from '../lib/http';

type EndArgs = Parameters<Response['end']>;

function runInTenant(req: Request, res: Response, next: NextFunction): void {
  const firm = req.firm!;
  const originalEnd = res.end.bind(res) as (...args: EndArgs) => Response;
  let endArgs: EndArgs | null = null;

  withTenant(firm, async () => {
    await new Promise<void>((resolve) => {
      res.end = ((...args: EndArgs) => {
        endArgs = args;
        resolve();
        return res;
      }) as Response['end'];
      next();
    });
    if (res.statusCode >= 500) {
      throw new RollbackSignal();
    }
  })
    .catch((error: unknown) => {
      if (error instanceof RollbackSignal) {
        return;
      }
      // The transaction failed to commit: the handler's response is no
      // longer true, so replace it with an error.
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'tenant_transaction_failed',
          requestId: req.requestId,
          error: errorMessage(error),
        }),
      );
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.removeHeader('content-length');
      endArgs = [
        JSON.stringify({ message: 'Internal server error', requestId: req.requestId }),
      ] as unknown as EndArgs;
    })
    .finally(() => {
      res.end = originalEnd as Response['end'];
      originalEnd(...((endArgs ?? []) as EndArgs));
    });
}

export function tenantContext(): RequestHandler {
  return (req, res, next) => {
    resolveFirmForHost(req.hostname || '')
      .then((firm) => {
        if (!firm) {
          res.status(404).json({ message: 'Unknown workspace', requestId: req.requestId });
          return;
        }
        if (firm.status !== 'active') {
          res
            .status(403)
            .json({ message: 'This workspace is not active', requestId: req.requestId });
          return;
        }
        req.firm = firm;
        runInTenant(req, res, next);
      })
      .catch(next);
  };
}

/**
 * Lifts matter-level access for the rest of the request, for statutory work
 * that must cover every matter: POPIA access requests and exports, erasure and
 * retention. Use only after requirePermission('compliance.admin'); the
 * services audit the operations themselves.
 */
export const fullFirmScope: RequestHandler = (_req, _res, next) => {
  elevateToSystem().then(
    () => next(),
    (error: unknown) => next(error),
  );
};
