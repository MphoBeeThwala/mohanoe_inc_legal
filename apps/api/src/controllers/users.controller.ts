import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as userService from '../services/user.service';

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

export const list = handle(async (_req, res) => {
  res.status(200).json(await userService.listUsers());
});

export const directory = handle(async (_req, res) => {
  res.status(200).json(await userService.directory());
});

export const update = handle(async (req, res) => {
  res
    .status(200)
    .json(await userService.updateUser(String(req.params.userId), req.body, req.auth ?? {}));
});

export const resetMfa = handle(async (req, res) => {
  res.status(200).json(await userService.resetMfa(String(req.params.userId), req.auth ?? {}));
});

export const passwordReset = handle(async (req, res) => {
  res
    .status(201)
    .json(await userService.adminPasswordReset(String(req.params.userId), req.auth ?? {}));
});

export const revokeSessions = handle(async (req, res) => {
  res.status(200).json(await userService.revokeSessions(String(req.params.userId), req.auth ?? {}));
});

export const listInvites = handle(async (_req, res) => {
  res.status(200).json(await userService.listInvites());
});

export const createInvite = handle(async (req, res) => {
  res.status(201).json(await userService.createInvite(req.body, req.auth ?? {}));
});

export const revokeInvite = handle(async (req, res) => {
  res.status(200).json(await userService.revokeInvite(String(req.params.inviteId), req.auth ?? {}));
});
