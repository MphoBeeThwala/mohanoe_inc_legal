// The platform console API (/api/platform), only on PLATFORM_CONSOLE_HOST.
// Mounted before the tenant middleware: no firm context.
import express, { type NextFunction, type Request, type Response } from 'express';
import { httpError, sendError } from '../lib/http';
import { createRateLimiter } from '../middleware/security';
import * as helpdesk from '../services/helpdesk.service';
import * as consoleService from '../services/platform-console.service';
import type { PlatformOperatorRow } from '../db/schema';

const router = express.Router();

// Not on a firm's address, and nowhere when the console is off.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!consoleService.isConsoleHost(req.hostname)) {
    res.status(404).json({ message: 'Not found' });
    return;
  }
  // Changes only from the console's own pages (the cookie is SameSite=Strict too).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (!origin || new URL(origin).hostname.toLowerCase() !== consoleService.consoleHost()) {
      sendError(res, httpError('Cross-site request refused', 403));
      return;
    }
  }
  res.setHeader('cache-control', 'no-store');
  next();
});

const signInLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
});

const op =
  (fn: (operator: PlatformOperatorRow, req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response) => {
    try {
      res.status(status).json(await fn(await consoleService.requireOperator(req), req));
    } catch (error) {
      sendError(res, error);
    }
  };

router.post('/sign-in', signInLimiter, async (req, res) => {
  try {
    res.json(await consoleService.signIn(req.body, res));
  } catch (error) {
    sendError(res, error);
  }
});
router.post('/sign-out', async (req, res) => {
  try {
    await consoleService.signOut(req, res);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});
router.get(
  '/me',
  op(async (operator) => consoleService.me(operator)),
);

router.get(
  '/firms',
  op(() => consoleService.listFirms()),
);
router.post(
  '/firms',
  op((operator, req) => consoleService.createFirmWithAdmin(operator, req.body), 201),
);
router.patch(
  '/firms/:id',
  op((operator, req) => consoleService.updateFirm(operator, String(req.params.id), req.body)),
);
router.post(
  '/firms/:id/complimentary',
  op((operator, req) => consoleService.setComplimentary(operator, String(req.params.id), req.body)),
);

router.get(
  '/plans',
  op(() => consoleService.plans()),
);
router.put(
  '/plans',
  op((operator, req) => consoleService.savePlan(operator, req.body)),
);
router.post(
  '/plans/:code/retire',
  op((operator, req) => consoleService.retirePlan(operator, String(req.params.code))),
);

router.get(
  '/sources',
  op(() => consoleService.sources()),
);
router.put(
  '/sources',
  op((operator, req) => consoleService.saveSource(operator, req.body)),
);
router.post(
  '/sources/:code/status',
  op((operator, req) =>
    consoleService.setSourceStatus(operator, String(req.params.code), req.body),
  ),
);

router.get(
  '/court-online',
  op(() => consoleService.courtOnlineCourts()),
);
router.put(
  '/court-online',
  op((operator, req) => consoleService.saveCourtOnline(operator, req.body)),
);
router.delete(
  '/court-online/:division',
  op((operator, req) => consoleService.removeCourtOnline(operator, String(req.params.division))),
);

router.get(
  '/tickets',
  op((_operator, req) =>
    helpdesk.consoleTickets(typeof req.query.status === 'string' ? req.query.status : undefined),
  ),
);
router.get(
  '/tickets/:firmId/:id',
  op((_operator, req) => helpdesk.consoleTicket(String(req.params.firmId), String(req.params.id))),
);
router.post(
  '/tickets/:firmId/:id/messages',
  op((operator, req) =>
    helpdesk.operatorReply(operator, String(req.params.firmId), String(req.params.id), req.body),
  ),
);
router.post(
  '/tickets/:firmId/:id/status',
  op((operator, req) =>
    helpdesk.setConsoleStatus(operator, String(req.params.firmId), String(req.params.id), req.body),
  ),
);

router.get(
  '/articles',
  op(() => helpdesk.consoleArticles()),
);
router.put(
  '/articles',
  op((operator, req) => helpdesk.saveArticle(operator, req.body)),
);
router.delete(
  '/articles/:slug',
  op(async (operator, req) => {
    await helpdesk.deleteArticle(operator, String(req.params.slug));
    return { slug: String(req.params.slug) };
  }),
);

router.get(
  '/audit',
  op(() => consoleService.auditLog()),
);

export default router;
