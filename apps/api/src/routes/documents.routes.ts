import express from 'express';
import * as documentsController from '../controllers/documents.controller';
import { authenticateRequest, requireRoles } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', documentsController.index);
router.post('/', documentsController.create);
router.get('/:documentId', documentsController.show);
router.post('/:documentId/sign', documentsController.sign);

export default router;
