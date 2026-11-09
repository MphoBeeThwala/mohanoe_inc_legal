import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as reportsService from '../services/reports.service';

async function dashboard(req: Request, res: Response) {
  try {
    const report = await reportsService.buildDashboard();
    res.status(200).json(report);
  } catch (error) {
    sendError(res, error);
  }
}

async function generate(req: Request, res: Response) {
  try {
    const report = await reportsService.generateSnapshot(req.body, req.auth);
    res.status(201).json(report);
  } catch (error) {
    sendError(res, error);
  }
}

async function index(req: Request, res: Response) {
  try {
    const reports = await reportsService.listSnapshots();
    res.status(200).json(reports);
  } catch (error) {
    sendError(res, error);
  }
}

export {
  dashboard,
  generate,
  index,
};
