import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as complianceService from '../services/compliance.service';

async function summary(req: Request, res: Response) {
  try {
    const data = await complianceService.getComplianceSummary();
    res.status(200).json(data);
  } catch (error) {
    sendError(res, error);
  }
}

async function index(req: Request, res: Response) {
  try {
    const requests = await complianceService.listRequests({
      status: req.query.status,
      requestType: req.query.requestType,
    });
    res.status(200).json(requests);
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req: Request, res: Response) {
  try {
    const request = await complianceService.createRequest(req.body, req.auth);
    res.status(201).json(request);
  } catch (error) {
    sendError(res, error);
  }
}

async function fulfill(req: Request, res: Response) {
  try {
    const request = await complianceService.fulfillRequest(
      String(req.params.requestId),
      req.body,
      req.auth,
    );
    res.status(200).json(request);
  } catch (error) {
    sendError(res, error);
  }
}

async function exportData(req: Request, res: Response) {
  try {
    const data = await complianceService.buildDataExport(req.query);
    res.status(200).json(data);
  } catch (error) {
    sendError(res, error);
  }
}

async function retentionSweep(req: Request, res: Response) {
  try {
    const data = await complianceService.runRetentionSweep(req.auth);
    res.status(200).json(data);
  } catch (error) {
    sendError(res, error);
  }
}

export { create, exportData, fulfill, index, retentionSweep, summary };
