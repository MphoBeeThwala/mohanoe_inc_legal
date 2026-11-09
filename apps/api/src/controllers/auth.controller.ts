import type { Request, Response } from 'express';
import type { SignInResult } from '@ahava88/shared';
import { httpError, sendError } from '../lib/http';
import * as authService from '../services/auth.service';
import * as sessionService from '../services/session.service';
import * as userService from '../services/user.service';
import * as oidcService from '../services/oidc.service';

type Handler = (req: Request, res: Response) => Promise<unknown>;

function handle(fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

function signedIn(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) {
    throw httpError('Not signed in', 401);
  }
  return req.auth;
}

export const config = handle(async (_req, res) => {
  res.status(200).json(authService.getAuthConfig());
});

export const login = handle(async (req, res) => {
  const result: SignInResult = await authService.signInWithPassword(req.body);
  res.status(200).json(result);
});

export const verifyMfa = handle(async (req, res) => {
  const user = await authService.verifyMfa(req.body);
  await sessionService.createSession(user, 'password', req, res);
  const result: SignInResult = { status: 'signed_in', user: authService.toPublicUser(user) };
  res.status(200).json(result);
});

export const startMfaEnrollment = handle(async (req, res) => {
  res.status(200).json(await authService.startMfaEnrollment(req.body));
});

export const confirmMfaEnrollment = handle(async (req, res) => {
  const { user, recoveryCodes } = await authService.confirmMfaEnrollment(req.body);
  await sessionService.createSession(user, 'password', req, res);
  res.status(200).json(authService.enrollmentResult(user, recoveryCodes));
});

export const logout = handle(async (req, res) => {
  await sessionService.revokeSession(signedIn(req).sessionId);
  sessionService.clearSessionCookie(res);
  res.status(204).end();
});

export const me = handle(async (req, res) => {
  const user = await authService.getSessionUser(signedIn(req).userId);
  if (!user) {
    throw httpError('Not signed in', 401);
  }
  res.status(200).json({ user });
});

export const listSessions = handle(async (req, res) => {
  const auth = signedIn(req);
  res.status(200).json(await sessionService.listUserSessions(auth.userId, auth.sessionId));
});

export const revokeOtherSessions = handle(async (req, res) => {
  const auth = signedIn(req);
  const revoked = await sessionService.revokeUserSessions(auth.userId, auth.sessionId);
  res.status(200).json({ revoked });
});

export const revokeSession = handle(async (req, res) => {
  const auth = signedIn(req);
  const own = await sessionService.listUserSessions(auth.userId, auth.sessionId);
  const target = own.find((session) => session.id === String(req.params.sessionId));
  if (!target) {
    throw httpError('Session not found', 404);
  }
  await sessionService.revokeSession(target.id);
  if (target.current) {
    sessionService.clearSessionCookie(res);
  }
  res.status(204).end();
});

export const changePassword = handle(async (req, res) => {
  const auth = signedIn(req);
  await authService.changePassword(auth.userId, auth.sessionId, req.body);
  res.status(204).end();
});

export const forgotPassword = handle(async (req, res) => {
  await userService.requestPasswordReset(req.body);
  res.status(202).json({
    message: 'If that address belongs to an account, a reset link is on its way.',
  });
});

export const resetPassword = handle(async (req, res) => {
  await userService.completePasswordReset(String(req.params.token), req.body);
  res.status(204).end();
});

export const previewInvite = handle(async (req, res) => {
  res.status(200).json(await userService.previewInvite(String(req.params.token)));
});

export const acceptInvite = handle(async (req, res) => {
  const user = await userService.acceptInviteWithPassword(String(req.params.token), req.body);
  // New accounts set up MFA before their first session.
  const result: SignInResult = {
    status: 'mfa_enrollment_required',
    challengeToken: authService.issueChallenge(user, 'mfa_enroll'),
  };
  res.status(201).json(result);
});

export const oidcStart = handle(async (req, res) => {
  await oidcService.start(req, res);
});

export const oidcCallback = handle(async (req, res) => {
  await oidcService.callback(req, res);
});
