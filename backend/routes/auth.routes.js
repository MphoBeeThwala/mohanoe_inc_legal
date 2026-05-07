const express = require('express');
const authController = require('../controllers/auth.controller');
const {
  authenticateRequest,
} = require('../services/auth.service');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/me', authenticateRequest, authController.me);
router.post('/seed-admin', authenticateRequest, authController.seedAdmin);

module.exports = router;
