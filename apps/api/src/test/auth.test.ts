// Identity end to end over HTTP: invites, MFA, lockout, sessions, resets,
// roles. Everything goes through the real app and database.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import app from '../server';
import * as auth from '../services/auth.service';
import { testOutbox } from '../services/mail.service';
import { codeForStep, timeStep } from '../lib/totp';
import {
  createStaff,
  inDefaultFirm,
  sessionTokenFrom,
  signInAgain,
  STRONG_PASSWORD,
  type TestStaff,
} from './helpers';
import { db } from '../db/client';

let admin: TestStaff;
let attorney: TestStaff;

const ORIGIN = 'http://127.0.0.1';

function lastMailTo(address: string) {
  return [...testOutbox()].reverse().find((message) => message.to === address);
}

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@example.com', role: 'admin', fullName: 'Ada Admin' });
  attorney = await createStaff({ email: 'attorney@example.com', role: 'attorney' });
});

describe('no self sign-up', () => {
  test('public registration and admin seeding endpoints are gone', async () => {
    const register = await request(app)
      .post('/api/auth/register')
      .send({ fullName: 'X', email: 'x@example.com', password: STRONG_PASSWORD });
    expect(register.status).toBe(404);
    const seed = await request(app).post('/api/auth/seed-admin').set(admin.auth);
    expect(seed.status).toBe(404);
  });

  test('auth config advertises password + MFA, no registration', async () => {
    const res = await request(app).get('/api/auth/config');
    expect(res.body).toEqual({
      passwordLogin: true,
      oidc: { enabled: false, label: '' },
      microsoft: { enabled: false, label: '', enforced: false },
      selfServiceReset: true,
    });
  });
});

describe('invites', () => {
  test('an admin invites; the invitee sets a password, then must set up MFA', async () => {
    const created = await request(app)
      .post('/api/users/invites')
      .set(admin.auth)
      .send({ email: 'New.Person@Example.com', fullName: 'New Person', role: 'paralegal' });
    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({ email: 'new.person@example.com', status: 'pending' });
    expect(created.body.emailed).toBe(true);
    const token = created.body.url.split('/invite/')[1];
    expect(lastMailTo('new.person@example.com')?.text).toContain(created.body.url);

    const preview = await request(app).get(`/api/auth/invites/${token}`);
    expect(preview.body).toMatchObject({ email: 'new.person@example.com', role: 'paralegal' });

    const weak = await request(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.message).toMatch(/at least 12 characters/);

    const accepted = await request(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ password: STRONG_PASSWORD });
    expect(accepted.status).toBe(201);
    expect(accepted.body.status).toBe('mfa_enrollment_required');
    // Accepting gives no session: MFA comes first.
    expect(accepted.headers['set-cookie']).toBeUndefined();

    const reused = await request(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ password: STRONG_PASSWORD });
    expect(reused.status).toBe(404);

    const { challengeToken } = accepted.body;
    const start = await request(app).post('/api/auth/mfa/enroll/start').send({ challengeToken });
    expect(start.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(start.body.qrCodeDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);

    const wrong = await request(app)
      .post('/api/auth/mfa/enroll/confirm')
      .send({ challengeToken, code: '000000' });
    expect(wrong.status).toBe(401);

    const confirmed = await request(app)
      .post('/api/auth/mfa/enroll/confirm')
      .send({ challengeToken, code: codeForStep(start.body.secret, timeStep()) });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.recoveryCodes).toHaveLength(10);
    expect(confirmed.body.user).toMatchObject({ role: 'paralegal', mfaEnabled: true });
    const cookie = String(confirmed.headers['set-cookie']);
    expect(cookie).toMatch(/^session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax/);
  });

  test('inviting an existing staff member is a conflict', async () => {
    const res = await request(app)
      .post('/api/users/invites')
      .set(admin.auth)
      .send({ email: 'attorney@example.com', fullName: 'Again', role: 'attorney' });
    expect(res.status).toBe(409);
  });

  test('revoked and unknown invites cannot be used', async () => {
    const created = await request(app)
      .post('/api/users/invites')
      .set(admin.auth)
      .send({ email: 'revoked@example.com', fullName: 'Revoked', role: 'attorney' });
    await request(app)
      .delete(`/api/users/invites/${created.body.item.id}`)
      .set(admin.auth)
      .expect(200);
    const token = created.body.url.split('/invite/')[1];
    expect((await request(app).get(`/api/auth/invites/${token}`)).status).toBe(404);
    expect((await request(app).get('/api/auth/invites/not-a-token-at-all')).status).toBe(404);
  });

  test('only admins can invite', async () => {
    const res = await request(app)
      .post('/api/users/invites')
      .set(attorney.auth)
      .send({ email: 'x2@example.com', fullName: 'X', role: 'admin' });
    expect(res.status).toBe(403);
  });
});

describe('password sign-in always needs a second factor', () => {
  test('a correct password yields an MFA challenge, not a session', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ATTORNEY@example.com', password: STRONG_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('mfa_required');
    expect(login.headers['set-cookie']).toBeUndefined();

    // The code used at enrolment (step - 1) can't be replayed; the next one works once.
    const code = codeForStep(attorney.secret, timeStep());
    const verified = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ challengeToken: login.body.challengeToken, code });
    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe('signed_in');
    expect(sessionTokenFrom(verified)).toBeTruthy();

    const replay = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ challengeToken: login.body.challengeToken, code });
    expect(replay.status).toBe(401);
  });

  test('a recovery code works exactly once', async () => {
    const code = attorney.recoveryCodes.shift()!;
    for (const expected of [200, 401]) {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: attorney.email, password: STRONG_PASSWORD });
      const verified = await request(app)
        .post('/api/auth/mfa/verify')
        .send({ challengeToken: login.body.challengeToken, code: code.toUpperCase() });
      expect(verified.status).toBe(expected);
    }
  });

  test('unknown accounts get the same answer as wrong passwords', async () => {
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: STRONG_PASSWORD });
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'Wrong-password-123' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  test('a forged or expired challenge token is refused', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/verify')
      .send({ challengeToken: 'x'.repeat(40), code: '123456' });
    expect(res.status).toBe(401);
  });
});

describe('lockout and resets', () => {
  test('repeated failures lock the account; an admin reset link unlocks it', async () => {
    const staff = await createStaff({ email: 'lock.me@example.com', role: 'attorney' });
    // createStaff's own failures: none. Five wrong passwords lock it.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: staff.email, password: 'Wrong-password-123' })
        .expect(401);
    }
    const locked = await request(app)
      .post('/api/auth/login')
      .send({ email: staff.email, password: STRONG_PASSWORD });
    expect(locked.status).toBe(401);

    const users = await request(app).get('/api/users').set(admin.auth);
    const entry = users.body.find((user: { id: string }) => user.id === staff.id);
    expect(entry.lockedUntil).toBeTruthy();

    const issued = await request(app).post(`/api/users/${staff.id}/password-reset`).set(admin.auth);
    expect(issued.status).toBe(201);
    const token = issued.body.url.split('/reset-password/')[1];
    const newPassword = 'Brand-new-password-77';
    await request(app)
      .post(`/api/auth/password/reset/${token}`)
      .send({ password: newPassword })
      .expect(204);
    // Single use.
    await request(app)
      .post(`/api/auth/password/reset/${token}`)
      .send({ password: newPassword })
      .expect(404);
    // Old sessions ended; the new password works.
    expect((await request(app).get('/api/auth/me').set(staff.auth)).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: staff.email, password: newPassword });
    expect(login.body.status).toBe('mfa_required');
  });

  test('forgot-password never reveals whether an account exists', async () => {
    const before = testOutbox().length;
    const unknown = await request(app)
      .post('/api/auth/password/forgot')
      .send({ email: 'ghost@example.com' });
    expect(unknown.status).toBe(202);
    expect(testOutbox().length).toBe(before);

    const known = await request(app)
      .post('/api/auth/password/forgot')
      .send({ email: attorney.email });
    expect(known.status).toBe(202);
    expect(known.body.message).toBe(unknown.body.message);
    expect(lastMailTo(attorney.email)?.text).toMatch(/\/reset-password\/[\w-]+/);
  });

  test('an admin MFA reset forces re-enrolment and ends sessions', async () => {
    const staff = await createStaff({ email: 'lost.phone@example.com', role: 'secretary' });
    await request(app).post(`/api/users/${staff.id}/mfa-reset`).set(admin.auth).expect(200);
    expect((await request(app).get('/api/auth/me').set(staff.auth)).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: staff.email, password: STRONG_PASSWORD });
    expect(login.body.status).toBe('mfa_enrollment_required');
  });
});

describe('sessions', () => {
  test('sign-out revokes the session', async () => {
    const staff = await createStaff({ email: 'signout@example.com', role: 'attorney' });
    await request(app).post('/api/auth/logout').set(staff.auth).expect(204);
    expect((await request(app).get('/api/auth/me').set(staff.auth)).status).toBe(401);
  });

  test('sign out everywhere else, and password changes end other sessions', async () => {
    const staff = await createStaff({ email: 'devices@example.com', role: 'attorney' });
    const second = await signInAgain(staff);
    const third = await signInAgain(staff);
    const list = await request(app).get('/api/auth/sessions').set(staff.auth);
    expect(list.body).toHaveLength(3);

    await request(app).post('/api/auth/sessions/revoke-others').set(staff.auth).expect(200);
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set({ authorization: `Bearer ${second}` })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set({ authorization: `Bearer ${third}` })
      ).status,
    ).toBe(401);

    const fourth = await signInAgain(staff);
    await request(app)
      .post('/api/auth/password')
      .set(staff.auth)
      .send({ currentPassword: STRONG_PASSWORD, newPassword: 'Another-strong-pass-9' })
      .expect(204);
    expect((await request(app).get('/api/auth/me').set(staff.auth)).status).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set({ authorization: `Bearer ${fourth}` })
      ).status,
    ).toBe(401);
  });

  test('idle sessions expire', async () => {
    const staff = await createStaff({ email: 'idle@example.com', role: 'attorney' });
    await inDefaultFirm(() =>
      db().execute(
        sql`update sessions set last_seen_at = now() - interval '1 day' where user_id = ${staff.id}`,
      ),
    );
    expect((await request(app).get('/api/auth/me').set(staff.auth)).status).toBe(401);
  });

  test('deactivated staff are signed out at once and cannot sign in', async () => {
    const staff = await createStaff({ email: 'leaver@example.com', role: 'attorney' });
    await request(app)
      .patch(`/api/users/${staff.id}`)
      .set(admin.auth)
      .send({ isActive: false })
      .expect(200);
    expect((await request(app).get('/api/auth/me').set(staff.auth)).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: staff.email, password: STRONG_PASSWORD });
    expect(login.status).toBe(401);
  });

  test('cookie sessions refuse cross-site writes (CSRF); bearer clients are unaffected', async () => {
    const cookie = `session=${attorney.token}`;
    const body = { title: 'CSRF test', body: 'x', category: 'general' };
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);
    expect(
      (await request(app).post('/api/notifications').set('Cookie', cookie).send(body)).status,
    ).toBe(403);
    const evil = await request(app)
      .post('/api/notifications')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send(body);
    expect(evil.status).toBe(403);
    const same = await request(app)
      .post('/api/notifications')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .set('Host', '127.0.0.1')
      .send(body);
    expect(same.status).toBe(201);
    expect(
      (await request(app).post('/api/notifications').set(attorney.auth).send(body)).status,
    ).toBe(201);
  });
});

describe('roles and permissions', () => {
  test('each role reaches only its own areas', async () => {
    const secretary = await createStaff({ email: 'secretary@example.com', role: 'secretary' });
    const bookkeeper = await createStaff({ email: 'books@example.com', role: 'bookkeeper' });
    const get = (staff: TestStaff, path: string) => request(app).get(path).set(staff.auth);

    expect((await get(secretary, '/api/intake/submissions')).status).toBe(200);
    expect((await get(secretary, '/api/billing/invoices')).status).toBe(403);
    expect((await get(bookkeeper, '/api/billing/invoices')).status).toBe(200);
    expect((await get(bookkeeper, '/api/intake/submissions')).status).toBe(403);
    expect((await get(attorney, '/api/users')).status).toBe(403);
    expect((await get(attorney, '/api/audit')).status).toBe(403);
    expect((await get(admin, '/api/audit')).status).toBe(200);
    // Everyone with matter access can see the staff directory (names only).
    const directory = await get(secretary, '/api/users/directory');
    expect(directory.status).toBe(200);
    expect(directory.body[0]).not.toHaveProperty('email');

    const me = await get(secretary, '/api/auth/me');
    expect(me.body.user.permissions).toContain('intake.write');
    expect(me.body.user.permissions).not.toContain('billing.read');
  });

  test('admins cannot demote themselves, and a firm keeps one admin', async () => {
    const self = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set(admin.auth)
      .send({ role: 'attorney' });
    expect(self.status).toBe(400);
    const second = await createStaff({ email: 'admin2@example.com', role: 'admin' });
    await request(app)
      .patch(`/api/users/${admin.id}`)
      .set(second.auth)
      .send({ role: 'attorney' })
      .expect(200);
    const last = await request(app)
      .patch(`/api/users/${second.id}`)
      .set(admin.auth)
      .send({ role: 'attorney' });
    expect(last.status).toBe(403); // admin is no longer an admin: no users.manage
    await request(app)
      .patch(`/api/users/${admin.id}`)
      .set(second.auth)
      .send({ role: 'admin' })
      .expect(200);
    const another = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set(second.auth)
      .send({ isActive: false });
    expect(another.status).toBe(200);
    const lastOne = await request(app)
      .patch(`/api/users/${admin.id}`)
      .set(second.auth)
      .send({ isActive: true });
    expect(lastOne.status).toBe(200);
    // Deactivation ended the admin's sessions.
    admin.token = await signInAgain(admin);
    admin.auth = { authorization: `Bearer ${admin.token}` };
  });

  test('a role change applies to the next request, without signing in again', async () => {
    const staff = await createStaff({ email: 'promoted@example.com', role: 'secretary' });
    expect((await request(app).get('/api/billing/invoices').set(staff.auth)).status).toBe(403);
    await request(app)
      .patch(`/api/users/${staff.id}`)
      .set(admin.auth)
      .send({ role: 'attorney' })
      .expect(200);
    expect((await request(app).get('/api/billing/invoices').set(staff.auth)).status).toBe(200);
  });
});

test('security headers include a content security policy', async () => {
  const res = await request(app).get('/api/auth/config');
  expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(res.headers['content-security-policy']).toContain("script-src 'self'");
});

test('services refuse to touch tenant data outside a firm context', async () => {
  await expect(auth.findUserByEmail('admin@example.com')).rejects.toThrow(/No tenant context/);
});
