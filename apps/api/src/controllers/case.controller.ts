import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as caseService from '../services/case.service';
import * as matterAccess from '../services/matter-access.service';

async function index(req: Request, res: Response) {
  try {
    const cases = await caseService.getCasesIndex();
    res.status(200).json(cases);
  } catch (error) {
    sendError(res, error);
  }
}

async function show(req: Request, res: Response) {
  try {
    const current = await caseService.getCase(String(req.params.caseId));
    if (!current) {
      return res.status(404).json({ message: 'Case not found' });
    }

    res.status(200).json(current);
  } catch (error) {
    sendError(res, error);
  }
}

async function addTask(req: Request, res: Response) {
  try {
    const task = await caseService.addTask(String(req.params.caseId), req.body, req.auth);
    res.status(201).json(task);
  } catch (error) {
    sendError(res, error);
  }
}

async function completeTask(req: Request, res: Response) {
  try {
    const task = await caseService.completeTask(
      String(req.params.caseId),
      String(req.params.taskId),
      req.auth,
    );
    res.status(200).json(task);
  } catch (error) {
    sendError(res, error);
  }
}

async function updateStatus(req: Request, res: Response) {
  try {
    const current = await caseService.updateCaseStatus(
      String(req.params.caseId),
      req.body,
      req.auth,
    );
    res.status(200).json(current);
  } catch (error) {
    sendError(res, error);
  }
}

async function addTimeline(req: Request, res: Response) {
  try {
    const entry = await caseService.addTimeline(String(req.params.caseId), req.body, req.auth);
    res.status(201).json(entry);
  } catch (error) {
    sendError(res, error);
  }
}

function accessHandler(fn: (caseRef: string, req: Request) => Promise<unknown>, status = 200) {
  return async (req: Request, res: Response) => {
    try {
      const result = await fn(String(req.params.caseId), req);
      if (result === null) {
        // The caller removed their own access to a restricted matter.
        return res.status(204).end();
      }
      res.status(status).json(result);
    } catch (error) {
      sendError(res, error);
    }
  };
}

const getAccess = accessHandler((ref, req) => matterAccess.getAccess(ref, req.auth ?? {}));
const setAccess = accessHandler((ref, req) =>
  matterAccess.setAccess(ref, req.body, req.auth ?? {}),
);
const addMember = accessHandler(
  (ref, req) => matterAccess.addMember(ref, req.body, req.auth ?? {}),
  201,
);
const removeMember = accessHandler((ref, req) =>
  matterAccess.removeMember(ref, String(req.params.userId), req.auth ?? {}),
);
const addExclusion = accessHandler(
  (ref, req) => matterAccess.addExclusion(ref, req.body, req.auth ?? {}),
  201,
);
const removeExclusion = accessHandler((ref, req) =>
  matterAccess.removeExclusion(ref, String(req.params.userId), req.auth ?? {}),
);

export {
  addExclusion,
  addMember,
  getAccess,
  removeExclusion,
  removeMember,
  setAccess,
  addTask,
  addTimeline,
  completeTask,
  index,
  show,
  updateStatus,
};
