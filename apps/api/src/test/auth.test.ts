import { test } from 'vitest';
import type { Request, Response } from 'express';
import assert from 'node:assert/strict';

import * as auth from '../services/auth.service';
import { inDefaultFirm } from './helpers';

const register = (input: Record<string, unknown>) => inDefaultFirm(() => auth.registerUser(input));
const login = (input: Record<string, unknown>) => inDefaultFirm(() => auth.loginUser(input));

const rejectsWith = (status: number, pattern?: RegExp) => (error: unknown) => {
  const { statusCode, message } = error as { statusCode?: number; message?: string };
  return statusCode === status && (!pattern || pattern.test(message ?? ''));
};

test("a firm's first account becomes its admin", async () => {
  const { user } = await register({
    fullName: 'Founding Partner',
    email: 'partner@example.com',
    password: 'CorrectHorse123',
  });
  assert.equal(user.role, 'admin');
});

test('register then log in with the correct password', async () => {
  const { user, token } = await register({
    fullName: 'Test Attorney',
    email: 'Attorney@Example.com',
    password: 'CorrectHorse123',
  });
  assert.equal(user.role, 'attorney');
  assert.equal(user.email, 'attorney@example.com');
  assert.ok(token);

  const session = await login({ email: 'attorney@example.com', password: 'CorrectHorse123' });
  assert.equal(session.user.email, 'attorney@example.com');
});

test('wrong password is rejected with 401', async () => {
  await assert.rejects(
    login({ email: 'attorney@example.com', password: 'WrongHorse123' }),
    rejectsWith(401),
  );
});

test('public registration cannot choose its own role', async () => {
  const { user } = await register({
    fullName: 'Sneaky',
    email: 'sneaky@example.com',
    password: 'CorrectHorse123',
    role: 'admin',
  });
  assert.equal(user.role, 'attorney');
});

test('duplicate emails are rejected with 409, case-insensitively', async () => {
  await assert.rejects(
    register({ fullName: 'Again', email: 'ATTORNEY@example.com', password: 'CorrectHorse123' }),
    rejectsWith(409),
  );
});

test('weak passwords are rejected with a clear message', async () => {
  await assert.rejects(
    register({ fullName: 'Weak', email: 'weak@example.com', password: 'short' }),
    rejectsWith(400, /at least 12 characters/),
  );
});

test('unknown accounts get the same 401 as wrong passwords', async () => {
  await assert.rejects(
    login({ email: 'nobody@example.com', password: 'CorrectHorse123' }),
    rejectsWith(401, /^Invalid credentials$/),
  );
});

test('services refuse to touch tenant data outside a firm context', async () => {
  await assert.rejects(
    auth.loginUser({ email: 'attorney@example.com', password: 'CorrectHorse123' }),
    /No tenant context/,
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
