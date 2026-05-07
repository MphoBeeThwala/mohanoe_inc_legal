const express = require('express');
const reportsController = require('../controllers/reports.controller');
const { authenticateRequest, requireRoles } = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/dashboard', reportsController.dashboard);
router.get('/', reportsController.index);
router.post('/', reportsController.generate);

module.exports = router;
