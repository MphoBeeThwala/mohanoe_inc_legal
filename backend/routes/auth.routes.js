const express = require('express');
const authController = require('../controllers/auth.controller');
const {
  authenticateRequest,
} = require('../services/auth.service');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/me', authenticateRequest, authController.me);

module.exports = router;
