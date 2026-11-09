// Read-only mode for firms whose subscription is suspended (unpaid past the
// grace period): reads, exports, signing in and paying keep working; every
// other change answers 402 until PayFast confirms a payment.
import type { RequestHandler } from 'express';
import { blocksWrites, writeAllowedWhileSuspended } from '../services/subscription.service';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function subscriptionGuard(): RequestHandler {
  return (req, res, next) => {
    const path = req.originalUrl.split('?')[0] ?? '';
    if (READS.has(req.method) || !req.firm || writeAllowedWhileSuspended(path)) {
      next();
      return;
    }
    blocksWrites().then(
      (blocked) => {
        if (!blocked) {
          next();
          return;
        }
        res.status(402).json({
          message:
            "This workspace is read-only because the firm's subscription is unpaid. An administrator can renew it under Account → Subscription.",
          code: 'subscription_suspended',
          requestId: req.requestId,
        });
      },
      (error: unknown) => next(error),
    );
  };
}
