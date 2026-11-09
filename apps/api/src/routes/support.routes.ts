import express from 'express';
import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import { authenticateRequest, requirePermission } from '../services/auth.service';
import * as supportService from '../services/support.service';

// Firm administrators manage platform support access to their own firm.
const router = express.Router();

router.use(authenticateRequest, requirePermission('users.manage'));

router.get('/grants', async (_req: Request, res: Response) => {
  try {
    res.status(200).json(await supportService.listGrants());
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/grants', async (req: Request, res: Response) => {
  try {
    res.status(201).json(await supportService.createGrant(req.body, req.auth ?? {}));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/grants/:grantId', async (req: Request, res: Response) => {
  try {
    res
      .status(200)
      .json(await supportService.revokeGrant(String(req.params.grantId), req.auth ?? {}));
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
