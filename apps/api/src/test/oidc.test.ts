// Entra External ID sign-in (OpenID Connect), against a local fake provider
// that implements discovery, JWKS and the token endpoint with PKCE checks.
import { createHash } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import app from '../server';
import { resetOidcCache } from '../services/oidc.service';
import { createStaff, sessionTokenFrom, type TestStaff } from './helpers';

const CLIENT_ID = 'test-client-id';

interface PendingCode {
  challenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}

const pending = new Map<string, PendingCode>();
let server: http.Server;
let issuer = '';
let admin: TestStaff;

async function startProvider() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') {
      return json(200, { keys: [jwk] });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        const form = new URLSearchParams(raw);
        const code = pending.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!code || code.challenge !== challenge) {
          return json(400, { error: 'invalid_grant' });
        }
        pending.delete(form.get('code')!);
        const idToken = await new SignJWT({ nonce: code.nonce, ...code.claims })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Runs the browser round trip: start → (provider) → callback. */
async function signInWithProvider(claims: Record<string, unknown>, inviteToken?: string) {
  const start = await request(app).get(
    `/api/auth/oidc/start${inviteToken ? `?invite=${inviteToken}` : ''}`,
  );
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.location);
  expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const stateCookie = String(start.headers['set-cookie']).split(';')[0]!;

  const code = `code-${Math.random().toString(36).slice(2)}`;
  pending.set(code, {
    challenge: authorize.searchParams.get('code_challenge')!,
    nonce: authorize.searchParams.get('nonce')!,
    claims,
  });
  return request(app)
    .get(`/api/auth/oidc/callback?code=${code}&state=${authorize.searchParams.get('state')}`)
    .set('Cookie', stateCookie);
}

async function inviteToken(email: string): Promise<string> {
  const invite = await request(app)
    .post('/api/users/invites')
    .set(admin.auth)
    .send({ email, fullName: 'Invited Person', role: 'attorney' });
  return invite.body.url.split('/invite/')[1];
}

beforeAll(async () => {
  await startProvider();
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = 'test-secret';
  process.env.OIDC_ALLOW_INSECURE = 'true';
  resetOidcCache();
  admin = await createStaff({ email: 'admin@oidc.example', role: 'admin' });
});

afterAll(async () => {
  for (const name of [
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_ALLOW_INSECURE',
    'OIDC_REQUIRE_MFA_CLAIM',
  ]) {
    delete process.env[name];
  }
  resetOidcCache();
  await new Promise((resolve) => server.close(resolve));
});

describe('Entra External ID sign-in', () => {
  test('the sign-in screen offers it', async () => {
    const config = await request(app).get('/api/auth/config');
    expect(config.body.oidc).toEqual({ enabled: true, label: 'Sign in with Microsoft' });
  });

  test('an invite links the Entra identity; later sign-ins find it by subject', async () => {
    const token = await inviteToken('entra.user@example.com');
    const first = await signInWithProvider(
      { sub: 'entra-sub-1', name: 'Entra User', amr: ['pwd', 'mfa'] },
      token,
    );
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/');
    const session = sessionTokenFrom(first);
    const me = await request(app).get('/api/auth/me').set('authorization', `Bearer ${session}`);
    expect(me.body.user).toMatchObject({
      email: 'entra.user@example.com',
      fullName: 'Entra User',
      role: 'attorney',
      signInMethods: ['oidc'],
    });

    // Same subject, no invite: signs in to the same account.
    const again = await signInWithProvider({ sub: 'entra-sub-1' });
    expect(again.headers.location).toBe('/');
    const meAgain = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${sessionTokenFrom(again)}`);
    expect(meAgain.body.user.id).toBe(me.body.user.id);

    // The invite was used up.
    expect((await request(app).get(`/api/auth/invites/${token}`)).status).toBe(404);
  });

  test('an identity without an invite gets no account (emails are never matched)', async () => {
    const res = await signInWithProvider({ sub: 'stranger', email: 'admin@oidc.example' });
    expect(res.headers.location).toBe('/?signin_error=not_invited');
    expect(res.headers['set-cookie']?.toString() ?? '').not.toMatch(/(^|, )session=[^;]/);
  });

  test('a mismatched state or missing state cookie is refused', async () => {
    const start = await request(app).get('/api/auth/oidc/start');
    const cookie = String(start.headers['set-cookie']).split(';')[0]!;
    const forged = await request(app)
      .get('/api/auth/oidc/callback?code=x&state=forged')
      .set('Cookie', cookie);
    expect(forged.headers.location).toBe('/?signin_error=oidc_failed');
    const noCookie = await request(app).get('/api/auth/oidc/callback?code=x&state=y');
    expect(noCookie.headers.location).toBe('/?signin_error=oidc_state_missing');
  });

  test('with OIDC_REQUIRE_MFA_CLAIM, a token without amr=mfa is refused', async () => {
    process.env.OIDC_REQUIRE_MFA_CLAIM = 'true';
    try {
      const token = await inviteToken('no.mfa@example.com');
      const res = await signInWithProvider({ sub: 'no-mfa', amr: ['pwd'] }, token);
      expect(res.headers.location).toBe('/?signin_error=mfa_required');
    } finally {
      delete process.env.OIDC_REQUIRE_MFA_CLAIM;
    }
  });

  test('deactivated staff cannot sign in with Entra', async () => {
    const token = await inviteToken('leaver.entra@example.com');
    const first = await signInWithProvider({ sub: 'leaver-sub' }, token);
    const me = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${sessionTokenFrom(first)}`);
    await request(app)
      .patch(`/api/users/${me.body.user.id}`)
      .set(admin.auth)
      .send({ isActive: false })
      .expect(200);
    const again = await signInWithProvider({ sub: 'leaver-sub' });
    expect(again.headers.location).toBe('/?signin_error=inactive');
  });

  test('password reset is refused for Entra-only accounts', async () => {
    const users = await request(app).get('/api/users').set(admin.auth);
    const entra = users.body.find(
      (user: { email: string }) => user.email === 'entra.user@example.com',
    );
    const res = await request(app).post(`/api/users/${entra.id}/password-reset`).set(admin.auth);
    expect(res.status).toBe(400);
  });
});
