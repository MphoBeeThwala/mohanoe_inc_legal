// A minimal OpenID Connect provider for tests: discovery, JWKS and a token
// endpoint that checks PKCE. The issuer can include a path, like Entra ID's
// https://login.microsoftonline.com/<tenant>/v2.0.
import { createHash } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import app from '../server';

export interface FakeProvider {
  origin: string;
  /** Runs start → provider → callback in the app; returns the callback response. */
  signIn(options: {
    startPath: string;
    claims: Record<string, unknown>;
    issuer: string;
    audience: string;
    host?: string;
  }): Promise<request.Response>;
  close(): Promise<void>;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const pending = new Map<
    string,
    {
      challenge: string;
      nonce: string;
      claims: Record<string, unknown>;
      issuer: string;
      audience: string;
    }
  >();
  let origin = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      const issuer = origin + url.pathname.replace('/.well-known/openid-configuration', '');
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
    if (url.pathname.endsWith('/jwks')) {
      return json(200, { keys: [jwk] });
    }
    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        const form = new URLSearchParams(raw);
        const code = pending.get(form.get('code') ?? '');
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (!code || code.challenge !== challenge) {
          return json(400, { error: 'invalid_grant' });
        }
        pending.delete(form.get('code')!);
        const idToken = await new SignJWT({ nonce: code.nonce, ...code.claims })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(code.issuer)
          .setAudience(code.audience)
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
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    async signIn({ startPath, claims, issuer, audience, host }) {
      const start = request(app).get(startPath);
      if (host) start.set('Host', host);
      const started = await start;
      if (started.status !== 302) {
        throw new Error(`start failed: ${started.status} ${JSON.stringify(started.body)}`);
      }
      const authorize = new URL(started.headers.location);
      const cookie = String(started.headers['set-cookie']).split(';')[0]!;
      const code = `code-${Math.random().toString(36).slice(2)}`;
      pending.set(code, {
        challenge: authorize.searchParams.get('code_challenge')!,
        nonce: authorize.searchParams.get('nonce')!,
        claims,
        issuer,
        audience,
      });
      const callback = request(app)
        .get(`/api/auth/oidc/callback?code=${code}&state=${authorize.searchParams.get('state')}`)
        .set('Cookie', cookie);
      if (host) callback.set('Host', host);
      return callback;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
