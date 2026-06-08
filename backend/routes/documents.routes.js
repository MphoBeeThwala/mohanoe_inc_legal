const express = require('express');
const documentsController = require('../controllers/documents.controller');
const { authenticateRequest, requireRoles } = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', documentsController.index);
router.post('/', documentsController.create);
router.get('/:documentId', documentsController.show);
router.post('/:documentId/sign', documentsController.sign);

module.exports = router;
