import express from 'express';
import * as usersController from '../controllers/users.controller';
import { authenticateRequest, requirePermission } from '../services/auth.service';

const router = express.Router();

router.use(authenticateRequest);

// Names and roles of active staff, for matter-member pickers.
router.get('/directory', requirePermission('matters.read'), usersController.directory);

router.use(requirePermission('users.manage'));
router.get('/', usersController.list);
router.get('/invites', usersController.listInvites);
router.post('/invites', usersController.createInvite);
router.delete('/invites/:inviteId', usersController.revokeInvite);
router.patch('/:userId', usersController.update);
router.post('/:userId/mfa-reset', usersController.resetMfa);
router.post('/:userId/password-reset', usersController.passwordReset);
router.post('/:userId/sessions/revoke', usersController.revokeSessions);

export default router;
