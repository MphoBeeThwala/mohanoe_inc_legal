import request from 'supertest';
import type { Response } from 'supertest';
import type { UserRole } from '@ahava88/shared';
import app from '../server';
import { withTenant } from '../db/tenant';
import type { FirmRow } from '../db/schema';
import { findFirmBySlug } from '../services/firm.service';
import { createInvite } from '../services/user.service';
import { codeForStep, timeStep } from '../lib/totp';

/** Runs fn as the default firm (created by setup.ts) with full matter visibility. */
export async function inDefaultFirm<T>(fn: () => Promise<T>): Promise<T> {
  return withTenant(await defaultFirm(), fn, { system: true });
}

export async function defaultFirm(): Promise<FirmRow> {
  const firm = await findFirmBySlug('default');
  if (!firm) {
    throw new Error('Default firm missing: is src/test/setup.ts loaded?');
  }
  return firm;
}

export const STRONG_PASSWORD = 'Correct-Horse-42-battery';

/** The session token from a response's Set-Cookie header. */
export function sessionTokenFrom(res: Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((value) => /^(__Host-)?session=/.test(value));
  const token = cookie?.split(';')[0]?.split('=')[1];
  if (!token) {
    throw new Error(`No session cookie in response (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return decodeURIComponent(token);
}

export interface TestStaff {
  id: string;
  email: string;
  role: UserRole;
  host: string | undefined;
  password: string;
  secret: string;
  recoveryCodes: string[];
  token: string;
  auth: { authorization: string };
}

function hostOf(req: request.Test, host?: string) {
  return host ? req.set('Host', host) : req;
}

/** Invites a staff member and takes them through acceptance and MFA set-up over HTTP. */
export async function createStaff(options: {
  email: string;
  role: UserRole;
  fullName?: string;
  firm?: FirmRow;
  host?: string;
}): Promise<TestStaff> {
  const firm = options.firm ?? (await defaultFirm());
  const issued = await withTenant(
    firm,
    () =>
      createInvite(
        { email: options.email, fullName: options.fullName ?? options.email, role: options.role },
        { fullName: 'Test setup', role: 'system' },
      ),
    { system: true },
  );
  const inviteToken = issued.url.split('/invite/')[1]!;

  const accepted = await hostOf(
    request(app).post(`/api/auth/invites/${inviteToken}/accept`),
    options.host,
  ).send({ password: STRONG_PASSWORD });
  if (accepted.status !== 201) {
    throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
  const challengeToken = accepted.body.challengeToken as string;
  const enrollment = await hostOf(
    request(app).post('/api/auth/mfa/enroll/start'),
    options.host,
  ).send({ challengeToken });
  const secret = enrollment.body.secret as string;
  const confirmed = await hostOf(
    request(app).post('/api/auth/mfa/enroll/confirm'),
    options.host,
  ).send({ challengeToken, code: codeForStep(secret, timeStep() - 1) });
  if (confirmed.status !== 200) {
    throw new Error(`enrol failed: ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
  }
  const token = sessionTokenFrom(confirmed);
  return {
    id: confirmed.body.user.id,
    email: options.email,
    role: options.role,
    host: options.host,
    password: STRONG_PASSWORD,
    secret,
    recoveryCodes: confirmed.body.recoveryCodes,
    token,
    auth: { authorization: `Bearer ${token}` },
  };
}

/** Signs in again (password + a recovery code, so TOTP steps aren't reused). */
export async function signInAgain(staff: TestStaff): Promise<string> {
  const login = await hostOf(request(app).post('/api/auth/login'), staff.host).send({
    email: staff.email,
    password: staff.password,
  });
  if (login.body.status !== 'mfa_required') {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  const code = staff.recoveryCodes.shift();
  if (!code) {
    throw new Error('Out of recovery codes');
  }
  const verified = await hostOf(request(app).post('/api/auth/mfa/verify'), staff.host).send({
    challengeToken: login.body.challengeToken,
    code,
  });
  return sessionTokenFrom(verified);
}
