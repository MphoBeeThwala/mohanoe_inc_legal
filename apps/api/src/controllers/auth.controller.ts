import type { Request, Response } from 'express';
import { sendError } from '../lib/http';
import * as authService from '../services/auth.service';

async function register(req: Request, res: Response) {
  try {
    const result = await authService.registerUser(req.body);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
}

async function login(req: Request, res: Response) {
  try {
    const result = await authService.loginUser(req.body);
    res.status(200).json(result);
  } catch (error) {
    sendError(res, error);
  }
}

async function me(req: Request, res: Response) {
  try {
    if (!req.auth) {
      return res.status(401).json({ message: 'Not signed in' });
    }
    const user = await authService.getSessionUser(req.auth.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ user });
  } catch (error) {
    sendError(res, error);
  }
}

async function config(_req: Request, res: Response) {
  res.status(200).json(authService.getAuthConfig());
}

async function seedAdmin(req: Request, res: Response) {
  try {
    const user = await authService.seedDefaultUsers();
    if (!user) {
      return res.status(400).json({
        message: 'DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD must be set to seed an admin user',
      });
    }

    res.status(200).json({ user });
  } catch (error) {
    sendError(res, error);
  }
}

export { config, login, me, seedAdmin, register };
