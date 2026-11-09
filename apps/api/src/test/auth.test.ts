import './memory-env';
import { test } from 'vitest';
import type { Request, Response } from 'express';
import assert from 'node:assert/strict';

import * as auth from '../services/auth.service';

test('register then log in with the correct password', async () => {
  const { user, token } = await auth.registerUser({
    fullName: 'Test Attorney',
    email: 'attorney@example.com',
    password: 'CorrectHorse123',
  });
  assert.equal(user.role, 'attorney');
  assert.ok(token);

  const login = await auth.loginUser({
    email: 'attorney@example.com',
    password: 'CorrectHorse123',
  });
  assert.equal(login.user.email, 'attorney@example.com');
});

test('wrong password is rejected with 401', async () => {
  await assert.rejects(
    auth.loginUser({ email: 'attorney@example.com', password: 'WrongHorse123' }),
    (error: { statusCode?: number }) => error.statusCode === 401,
  );
});

test('public registration cannot choose its own role', async () => {
  const { user } = await auth.registerUser({
    fullName: 'Sneaky',
    email: 'sneaky@example.com',
    password: 'CorrectHorse123',
    role: 'admin',
  });
  assert.equal(user.role, 'attorney');
});

test('requireRoles blocks non-admins', () => {
  const middleware = auth.requireRoles('admin');
  let received: unknown;
  const req = { auth: { role: 'paralegal' } } as unknown as Request;
  middleware(req, {} as Response, (error?: unknown) => {
    received = error;
  });
  assert.equal((received as { statusCode?: number }).statusCode, 403);
});
