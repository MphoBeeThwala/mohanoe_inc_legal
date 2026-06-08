const express = require('express');
const authController = require('../controllers/auth.controller');
const {
  authenticateRequest,
  requireAdminSeedAccess,
  requireRoles,
} = require('../services/auth.service');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/me', authenticateRequest, authController.me);
router.post('/seed-admin', requireAdminSeedAccess, authController.seedAdmin);
router.post(
  '/users',
  authenticateRequest,
  requireRoles('admin'),
  authController.provisionUser,
);

module.exports = router;
