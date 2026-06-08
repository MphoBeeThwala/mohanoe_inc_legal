
const express = require('express');
const router = express.Router();
const clientController = require('../controllers/client.controller');
const {
  authenticateRequest,
  requireRoles,
} = require('../services/auth.service');

router.use(authenticateRequest);
router.use(requireRoles('admin', 'attorney', 'paralegal'));

router.post('/', clientController.createClient);
router.get('/', clientController.getAllClients);

module.exports = router;
