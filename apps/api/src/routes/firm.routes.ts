import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as settingsService from '../services/firm-settings.service';

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

export default router;
