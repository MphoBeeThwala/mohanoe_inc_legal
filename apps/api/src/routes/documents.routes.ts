import express from 'express';
import * as documentsController from '../controllers/documents.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

router.get('/', requirePermission('documents.read'), documentsController.index);
router.post('/', requirePermission('documents.write'), documentsController.create);
router.get('/:documentId', requirePermission('documents.read'), documentsController.show);
router.post('/:documentId/sign', requirePermission('documents.write'), documentsController.sign);

export default router;
