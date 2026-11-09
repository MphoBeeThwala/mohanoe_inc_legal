import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as caseService from '../services/case.service';

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
    const entry = await caseService.addTimeline(
      String(req.params.caseId),
      req.body,
      req.auth,
    );
    res.status(201).json(entry);
  } catch (error) {
    sendError(res, error);
  }
}

export {
  addTask,
  addTimeline,
  completeTask,
  index,
  show,
  updateStatus,
};
