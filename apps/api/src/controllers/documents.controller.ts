import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as documentsService from '../services/documents.service';

async function index(req: Request, res: Response) {
  try {
    const documents = await documentsService.listDocuments();
    res.status(200).json(documents);
  } catch (error) {
    sendError(res, error);
  }
}

async function show(req: Request, res: Response) {
  try {
    const document = await documentsService.getDocument(String(req.params.documentId));
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }

    res.status(200).json(document);
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req: Request, res: Response) {
  try {
    const document = await documentsService.createDocument(req.body, req.auth);
    res.status(201).json(document);
  } catch (error) {
    sendError(res, error);
  }
}

async function sign(req: Request, res: Response) {
  try {
    const document = await documentsService.signDocument(String(req.params.documentId), req.auth);
    res.status(200).json(document);
  } catch (error) {
    sendError(res, error);
  }
}

export {
  create,
  index,
  show,
  sign,
};
