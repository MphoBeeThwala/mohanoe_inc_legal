const express = require('express');
const calendarController = require('../controllers/calendar.controller');
const { authenticateRequest, requireRoles } = require('../services/auth.service');

const router = express.Router();

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.get('/', calendarController.index);
router.get('/upcoming', calendarController.upcoming);
router.post('/', calendarController.create);

module.exports = router;
