// Sign-in with Microsoft Entra External ID (any OpenID Connect provider).
//
// Authorization code flow with PKCE, state and nonce (openid-client). The
// redirect URI is <firm address>/api/auth/oidc/callback; register it for each
// firm in the Entra app registration. MFA is enforced by Entra (enable MFA in
// the External ID user flow / Conditional Access); OIDC_REQUIRE_MFA_CLAIM=true
// additionally requires the ID token's amr claim to include "mfa".
//
// An Entra identity is linked to a staff account only through an invite
// (/api/auth/oidc/start?invite=…). After that, sign-in finds the account by
// issuer + subject; email addresses are never used to match accounts.
import { eq, and } from 'drizzle-orm';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { oidcSettings, authSettings, type OidcSettings } from '../config/auth';
import { requireSecret } from '../config/env';
import { db } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { users, type UserRow } from '../db/schema';
import { HttpError, httpError } from '../lib/http';
import { clearCookie, readCookie, setCookie } from '../lib/cookies';
import { firmOrigin } from './firm.service';
import * as authService from './auth.service';
import * as sessionService from './session.service';
import * as userService from './user.service';

type OidcLib = typeof import('openid-client');
type Configuration = import('openid-client').Configuration;

const STATE_MINUTES = 10;
let libPromise: Promise<OidcLib> | null = null;
let configPromise: Promise<Configuration> | null = null;
let configKey = '';

function lib(): Promise<OidcLib> {
  // openid-client is ESM-only; load it once from this CommonJS module.
  libPromise ??= import('openid-client');
  return libPromise;
}

function requireSettings(): OidcSettings {
  const settings = oidcSettings();
  if (!settings) {
    throw httpError('Microsoft sign-in is not configured', 404);
  }
  return settings;
}

async function configuration(settings: OidcSettings): Promise<Configuration> {
  const key = `${settings.issuer}|${settings.clientId}`;
  if (!configPromise || key !== configKey) {
    configKey = key;
    configPromise = lib().then((client) =>
      client.discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret || undefined,
        undefined,
        settings.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
      ),
    );
    configPromise.catch(() => {
      configPromise = null;
    });
  }
  return configPromise;
}

/** Test helper: forget the discovered provider configuration. */
export function resetOidcCache(): void {
  configPromise = null;
}

function redirectUri(): string {
  return `${firmOrigin(currentFirm())}/api/auth/oidc/callback`;
}

function stateSecret(): string {
  return requireSecret('JWT_SECRET', 'local-development-jwt-secret');
}

interface StateClaims extends JwtPayload {
  state: string;
  nonce: string;
  verifier: string;
  firmId: string;
  invite?: string;
}

/** Redirects the browser to Entra. */
export async function start(req: Request, res: Response): Promise<void> {
  const settings = requireSettings();
  const client = await lib();
  const config = await configuration(settings);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const invite = typeof req.query.invite === 'string' ? req.query.invite.slice(0, 200) : undefined;

  const signed = jwt.sign(
    { state, nonce, verifier, firmId: currentFirm().id, invite },
    stateSecret(),
    { algorithm: 'HS256', audience: 'oidc-state', expiresIn: STATE_MINUTES * 60 },
  );
  const cookie = authSettings();
  setCookie(res, cookie.oidcCookie, signed, {
    secure: cookie.secureCookies,
    sameSite: 'Lax',
    maxAgeSeconds: STATE_MINUTES * 60,
  });

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  res.redirect(302, url.href);
}

function readState(req: Request): StateClaims {
  const raw = readCookie(req, authSettings().oidcCookie);
  if (!raw) {
    throw httpError('oidc_state_missing', 400);
  }
  try {
    const decoded = jwt.verify(raw, stateSecret(), {
      algorithms: ['HS256'],
      audience: 'oidc-state',
    });
    if (typeof decoded === 'string' || decoded.firmId !== currentFirm().id) {
      throw new Error('bad state');
    }
    return decoded as StateClaims;
  } catch {
    throw httpError('oidc_state_invalid', 400);
  }
}

async function findLinkedUser(issuer: string, subject: string): Promise<UserRow | null> {
  const [user] = await db()
    .select()
    .from(users)
    .where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject)))
    .limit(1);
  return user ?? null;
}

/** Handles Entra's redirect back: exchanges the code, signs the user in, redirects to the app. */
export async function callback(req: Request, res: Response): Promise<void> {
  const cookie = authSettings();
  clearCookie(res, cookie.oidcCookie, { secure: cookie.secureCookies, sameSite: 'Lax' });
  try {
    const settings = requireSettings();
    const stateClaims = readState(req);
    const client = await lib();
    const config = await configuration(settings);
    const query = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';
    const tokens = await client.authorizationCodeGrant(config, new URL(redirectUri() + query), {
      pkceCodeVerifier: stateClaims.verifier,
      expectedState: stateClaims.state,
      expectedNonce: stateClaims.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub || !claims.iss) {
      throw httpError('oidc_failed', 400);
    }
    if (settings.requireMfaClaim) {
      const amr = Array.isArray(claims.amr) ? claims.amr : [];
      if (!amr.includes('mfa')) {
        throw httpError('mfa_required', 403);
      }
    }

    let user = await findLinkedUser(claims.iss, claims.sub);
    if (!user && stateClaims.invite) {
      user = await userService.acceptInviteWithOidc(stateClaims.invite, {
        issuer: claims.iss,
        subject: claims.sub,
        name: typeof claims.name === 'string' ? claims.name : undefined,
      });
    }
    if (!user) {
      throw httpError('not_invited', 403);
    }
    if (!user.isActive) {
      throw httpError('inactive', 403);
    }

    const signedIn = await authService.recordSignIn(user, 'oidc');
    await sessionService.createSession(signedIn, 'oidc', req, res);
    res.redirect(302, '/');
  } catch (error) {
    const code =
      error instanceof HttpError && /^[a-z_]+$/.test(error.message) ? error.message : 'oidc_failed';
    if (!(error instanceof HttpError)) {
      console.error(
        JSON.stringify({
          level: 'warn',
          message: 'oidc_callback_failed',
          requestId: req.requestId,
          // Provider errors carry no personal information; keep the message only.
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    res.redirect(302, `/?signin_error=${code}`);
  }
}
