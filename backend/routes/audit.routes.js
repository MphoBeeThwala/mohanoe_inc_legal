const express = require('express');
const auditController = require('../controllers/audit.controller');
const { authenticateRequest, requireRoles } = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', auditController.index);
router.get('/verify', requireRoles('admin'), auditController.verify);

module.exports = router;
