import { test } from 'vitest';
import type { Request, Response } from 'express';
import assert from 'node:assert/strict';

import * as auth from '../services/auth.service';

test('the first account on a new installation becomes the admin', async () => {
  const { user } = await auth.registerUser({
    fullName: 'Founding Partner',
    email: 'partner@example.com',
    password: 'CorrectHorse123',
  });
  assert.equal(user.role, 'admin');
});

test('register then log in with the correct password', async () => {
  const { user, token } = await auth.registerUser({
    fullName: 'Test Attorney',
    email: 'Attorney@Example.com',
    password: 'CorrectHorse123',
  });
  assert.equal(user.role, 'attorney');
  assert.equal(user.email, 'attorney@example.com');
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

test('duplicate emails are rejected with 409, case-insensitively', async () => {
  await assert.rejects(
    auth.registerUser({
      fullName: 'Again',
      email: 'ATTORNEY@example.com',
      password: 'CorrectHorse123',
    }),
    (error: { statusCode?: number }) => error.statusCode === 409,
  );
});

test('weak passwords are rejected with a clear message', async () => {
  await assert.rejects(
    auth.registerUser({ fullName: 'Weak', email: 'weak@example.com', password: 'short' }),
    (error: { statusCode?: number; message?: string }) =>
      error.statusCode === 400 && /at least 12 characters/.test(error.message ?? ''),
  );
});

test('unknown accounts get the same 401 as wrong passwords', async () => {
  await assert.rejects(
    auth.loginUser({ email: 'nobody@example.com', password: 'CorrectHorse123' }),
    (error: { statusCode?: number; message?: string }) =>
      error.statusCode === 401 && error.message === 'Invalid credentials',
  );
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
