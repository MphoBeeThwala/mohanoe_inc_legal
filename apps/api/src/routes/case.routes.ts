import express, { type Request, type Response } from 'express';
import { sendError } from '../lib/http';
import * as courtService from '../services/court.service';
import * as clientsService from '../services/clients.service';
import * as caseController from '../controllers/case.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/', requirePermission('matters.read'), caseController.index);
router.get('/:caseId', requirePermission('matters.read'), caseController.show);
router.post('/:caseId/tasks', requirePermission('matters.write'), caseController.addTask);
router.post(
  '/:caseId/tasks/:taskId/complete',
  requirePermission('matters.write'),
  caseController.completeTask,
);
router.post('/:caseId/status', requirePermission('matters.write'), caseController.updateStatus);
router.get('/:caseId/court-online', requirePermission('matters.read'), async (req, res) => {
  try {
    res.json(await courtService.courtOnlineFor(String(req.params.caseId)));
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:caseId/court', requirePermission('matters.write'), async (req, res) => {
  try {
    res.json(await courtService.setMatterCourt(String(req.params.caseId), req.body, req.auth));
  } catch (error) {
    sendError(res, error);
  }
});
router.post('/:caseId/timeline', requirePermission('matters.write'), caseController.addTimeline);

// Opening a matter for a client, and who is on a matter.
router.post(
  '/',
  requirePermission('matters.write', 'clients.read'),
  async (req: Request, res: Response) => {
    try {
      res.status(201).json(await clientsService.openMatter(req.body, req.auth ?? {}));
    } catch (error) {
      sendError(res, error);
    }
  },
);
router.get(
  '/:caseId/parties',
  requirePermission('matters.read', 'clients.read'),
  async (req: Request, res: Response) => {
    try {
      res.status(200).json(await clientsService.matterParties(String(req.params.caseId)));
    } catch (error) {
      sendError(res, error);
    }
  },
);
router.post(
  '/:caseId/parties',
  requirePermission('matters.write', 'clients.read'),
  async (req: Request, res: Response) => {
    try {
      res
        .status(201)
        .json(
          await clientsService.addMatterParty(String(req.params.caseId), req.body, req.auth ?? {}),
        );
    } catch (error) {
      sendError(res, error);
    }
  },
);
router.delete(
  '/:caseId/parties/:partyId/:role',
  requirePermission('matters.write'),
  async (req: Request, res: Response) => {
    try {
      res
        .status(200)
        .json(
          await clientsService.removeMatterParty(
            String(req.params.caseId),
            String(req.params.partyId),
            String(req.params.role),
            req.auth ?? {},
          ),
        );
    } catch (error) {
      sendError(res, error);
    }
  },
);

// Matter access and ethical walls (admins and the matter's leads manage them).
router.get('/:caseId/access', requirePermission('matters.read'), caseController.getAccess);
router.put('/:caseId/access', requirePermission('matters.write'), caseController.setAccess);
router.post('/:caseId/members', requirePermission('matters.write'), caseController.addMember);
router.delete(
  '/:caseId/members/:userId',
  requirePermission('matters.write'),
  caseController.removeMember,
);
router.post('/:caseId/exclusions', requirePermission('matters.write'), caseController.addExclusion);
router.delete(
  '/:caseId/exclusions/:userId',
  requirePermission('matters.write'),
  caseController.removeExclusion,
);

export default router;
