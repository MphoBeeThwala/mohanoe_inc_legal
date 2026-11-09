// Per-firm Microsoft 365 (Entra ID workforce) sign-in.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import app from '../server';
import { createFirm } from '../services/firm.service';
import { resetOidcCache } from '../services/oidc.service';
import { createStaff, sessionTokenFrom, STRONG_PASSWORD, type TestStaff } from './helpers';
import { startFakeProvider, type FakeProvider } from './fake-oidc';

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = 'platform-workforce-app';
let provider: FakeProvider;
let admin: TestStaff;
let attorney: TestStaff;
let issuer: string;

const microsoftSignIn = (claims: Record<string, unknown>, host?: string) =>
  provider.signIn({
    startPath: '/api/auth/oidc/start?provider=microsoft',
    claims: { tid: TENANT, ...claims },
    issuer,
    audience: CLIENT_ID,
    host,
  });

beforeAll(async () => {
  provider = await startFakeProvider();
  issuer = `${provider.origin}/${TENANT}/v2.0`;
  process.env.ENTRA_WORKFORCE_CLIENT_ID = CLIENT_ID;
  process.env.ENTRA_WORKFORCE_CLIENT_SECRET = 'secret';
  process.env.ENTRA_WORKFORCE_AUTHORITY = provider.origin;
  process.env.OIDC_ALLOW_INSECURE = 'true';
  resetOidcCache();
  admin = await createStaff({ email: 'admin@nkosi.example', role: 'admin' });
  attorney = await createStaff({ email: 'thandi@nkosi.example', role: 'attorney' });
});

afterAll(async () => {
  for (const name of [
    'ENTRA_WORKFORCE_CLIENT_ID',
    'ENTRA_WORKFORCE_CLIENT_SECRET',
    'ENTRA_WORKFORCE_AUTHORITY',
    'OIDC_ALLOW_INSECURE',
  ]) {
    delete process.env[name];
  }
  resetOidcCache();
  await provider.close();
});

describe('setting it up', () => {
  test('off until the firm sets its directory; only admins can set it', async () => {
    const config = await request(app).get('/api/auth/config');
    expect(config.body.microsoft).toEqual({ enabled: false, label: '', enforced: false });
    expect(
      (
        await request(app)
          .patch('/api/firm/settings')
          .set(attorney.auth)
          .send({ microsoft: { tenantId: TENANT, domains: ['nkosi.example'], enforced: false } })
      ).status,
    ).toBe(403);
    const bad = await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({ microsoft: { tenantId: 'not-a-guid', domains: ['nkosi.example'], enforced: false } });
    expect(bad.status).toBe(400);
    const prematureEnforce = await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({ microsoft: { tenantId: null, domains: [], enforced: true } });
    expect(prematureEnforce.status).toBe(400);

    const saved = await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({ microsoft: { tenantId: TENANT, domains: ['Nkosi.Example'], enforced: false } });
    expect(saved.status).toBe(200);
    expect(saved.body.microsoft).toMatchObject({
      available: true,
      tenantId: TENANT,
      domains: ['nkosi.example'],
      enforced: false,
    });
    expect(saved.body.microsoft.adminConsentUrl).toContain(
      `/${TENANT}/adminconsent?client_id=${CLIENT_ID}`,
    );
    expect((await request(app).get('/api/auth/config')).body.microsoft).toEqual({
      enabled: true,
      label: 'Sign in with Microsoft 365',
      enforced: false,
    });
  });

  test('another firm is not affected', async () => {
    await createFirm({ slug: 'sso-other', legalName: 'Other', domains: ['portal.sso-other.test'] });
    const config = await request(app).get('/api/auth/config').set('Host', 'portal.sso-other.test');
    expect(config.body.microsoft.enabled).toBe(false);
  });
});

describe('signing in with Microsoft 365', () => {
  test('an existing staff member is linked by their work address, then found by subject', async () => {
    const first = await microsoftSignIn({
      sub: 'ms-thandi',
      preferred_username: 'Thandi@nkosi.example',
    });
    expect(first.headers.location).toBe('/');
    const me = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${sessionTokenFrom(first)}`);
    expect(me.body.user).toMatchObject({ id: attorney.id, signInMethods: ['password', 'oidc'] });

    const again = await microsoftSignIn({
      sub: 'ms-thandi',
      preferred_username: 'renamed@nkosi.example',
    });
    const meAgain = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${sessionTokenFrom(again)}`);
    expect(meAgain.body.user.id).toBe(attorney.id);
  });

  test('no account is ever created this way, and guests and other domains are refused', async () => {
    for (const username of [
      'newcomer@nkosi.example',
      'admin_nkosi.example#EXT#@contoso.onmicrosoft.com',
      'admin@elsewhere.example',
    ]) {
      const res = await microsoftSignIn({ sub: `sub-${username}`, preferred_username: username });
      expect(res.headers.location, username).toBe('/?signin_error=not_invited');
    }
  });

  test('a token for another directory is refused', async () => {
    const res = await microsoftSignIn({
      sub: 'ms-admin',
      preferred_username: 'admin@nkosi.example',
      tid: '99999999-2222-4333-8444-555555555555',
    });
    expect(res.headers.location).toBe('/?signin_error=wrong_directory');
  });

  test('an invite can be accepted with Microsoft 365', async () => {
    const invite = await request(app)
      .post('/api/users/invites')
      .set(admin.auth)
      .send({ email: 'sipho@nkosi.example', fullName: 'Sipho', role: 'paralegal' });
    const token = invite.body.url.split('/invite/')[1];
    const res = await provider.signIn({
      startPath: `/api/auth/oidc/start?provider=microsoft&invite=${token}`,
      claims: { tid: TENANT, sub: 'ms-sipho', preferred_username: 'sipho@nkosi.example' },
      issuer,
      audience: CLIENT_ID,
    });
    expect(res.headers.location).toBe('/');
  });
});

describe('requiring Microsoft 365', () => {
  beforeAll(async () => {
    await request(app)
      .patch('/api/firm/settings')
      .set(admin.auth)
      .send({ microsoft: { tenantId: TENANT, domains: ['nkosi.example'], enforced: true } })
      .expect(200);
  });

  test('staff on the firm’s domains can no longer use passwords', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: attorney.email, password: STRONG_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Microsoft 365/);
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@nkosi.example', password: STRONG_PASSWORD });
    expect(unknown.status).toBe(403);
    expect(unknown.body.message).toBe(res.body.message);
  });

  test('administrators keep password + authenticator as a break-glass route', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: admin.email, password: STRONG_PASSWORD });
    expect(res.body.status).toBe('mfa_required');
  });

  test('the sign-in screen is told it is required', async () => {
    expect((await request(app).get('/api/auth/config')).body.microsoft.enforced).toBe(true);
  });
});
