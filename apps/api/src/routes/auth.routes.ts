import express from 'express';
import * as authController from '../controllers/auth.controller';
import { authenticateRequest } from '../services/auth.service';
import { createRateLimiter } from '../middleware/security';

const router = express.Router();

// Credential and token endpoints get a much tighter per-IP limit.
const authLimiter = createRateLimiter({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
});

router.get('/config', authController.config);
router.post('/login', authLimiter, authController.login);
router.post('/mfa/verify', authLimiter, authController.verifyMfa);
router.post('/mfa/enroll/start', authLimiter, authController.startMfaEnrollment);
router.post('/mfa/enroll/confirm', authLimiter, authController.confirmMfaEnrollment);
router.post('/password/forgot', authLimiter, authController.forgotPassword);
router.post('/password/reset/:token', authLimiter, authController.resetPassword);
router.get('/invites/:token', authLimiter, authController.previewInvite);
router.post('/invites/:token/accept', authLimiter, authController.acceptInvite);
router.get('/oidc/start', authLimiter, authController.oidcStart);
router.get('/oidc/callback', authLimiter, authController.oidcCallback);

router.get('/me', authenticateRequest, authController.me);
router.post('/logout', authenticateRequest, authController.logout);
router.post('/password', authenticateRequest, authLimiter, authController.changePassword);
router.get('/sessions', authenticateRequest, authController.listSessions);
router.post('/sessions/revoke-others', authenticateRequest, authController.revokeOtherSessions);
router.delete('/sessions/:sessionId', authenticateRequest, authController.revokeSession);

export default router;
