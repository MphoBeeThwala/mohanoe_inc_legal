import express from 'express';
import type { Request, Response } from 'express';
import { httpError, sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as settingsService from '../services/firm-settings.service';
import * as whiteLabel from '../services/white-label.service';

const router = express.Router();

router.use(authenticateRequest, requirePermission('users.manage'));

router.get('/settings', (_req: Request, res: Response) => {
  res.status(200).json(settingsService.getSettings());
});

router.patch('/settings', async (req: Request, res: Response) => {
  try {
    res.status(200).json(await settingsService.updateSettings(req.body, req.auth ?? {}));
  } catch (error) {
    sendError(res, error);
  }
});

type Handler = (req: Request) => Promise<unknown>;
const handle =
  (fn: Handler, status = 200) =>
  async (req: Request, res: Response) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error) {
      sendError(res, error);
    }
  };

const assetKind = (req: Request) => {
  const kind = String(req.params.kind);
  if (kind !== 'logo' && kind !== 'icon') {
    throw httpError('Not found', 404);
  }
  return kind;
};

router.put(
  '/assets/:kind',
  handle(async (req) => whiteLabel.uploadAsset(assetKind(req), req.body, req.auth ?? {})),
);
router.delete(
  '/assets/:kind',
  handle(async (req) => whiteLabel.deleteAsset(assetKind(req), req.auth ?? {})),
);

router.get(
  '/domains',
  handle(() => whiteLabel.listDomains()),
);
router.post(
  '/domains',
  handle((req) => whiteLabel.addDomain(req.body, req.auth ?? {}), 201),
);
router.post(
  '/domains/:id/check',
  handle((req) => whiteLabel.checkDomain(String(req.params.id), req.auth ?? {})),
);
router.delete(
  '/domains/:id',
  handle((req) => whiteLabel.removeDomain(String(req.params.id), req.auth ?? {})),
);

router.get(
  '/onboarding',
  handle(async () => whiteLabel.onboardingStatus()),
);
router.patch(
  '/onboarding',
  handle((req) => whiteLabel.updateOnboarding(req.body, req.auth ?? {})),
);

export default router;
