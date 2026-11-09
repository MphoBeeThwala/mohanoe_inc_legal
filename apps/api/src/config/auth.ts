// Identity settings, read from the environment. See .env.example.
import { isProduction } from './env';

function numberFrom(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value.toLowerCase() === 'true';
}

export function authSettings() {
  const secure = flag('SESSION_COOKIE_SECURE', isProduction());
  return {
    /** Browsers only accept __Host- cookies when Secure, path=/ and no domain. */
    sessionCookie: secure ? '__Host-session' : 'session',
    oidcCookie: secure ? '__Host-oidc' : 'oidc',
    secureCookies: secure,
    sessionIdleMinutes: numberFrom('SESSION_IDLE_MINUTES', 120),
    sessionMaxHours: numberFrom('SESSION_MAX_HOURS', 12),
    maxFailedAttempts: numberFrom('LOGIN_MAX_ATTEMPTS', 5),
    lockoutMinutes: numberFrom('LOGIN_LOCKOUT_MINUTES', 15),
    inviteDays: numberFrom('INVITE_EXPIRY_DAYS', 7),
    resetMinutes: numberFrom('PASSWORD_RESET_EXPIRY_MINUTES', 60),
    passwordLogin: flag('AUTH_PASSWORD_ENABLED', true),
  };
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  /** Require the ID token's amr claim to include "mfa". */
  requireMfaClaim: boolean;
  /** Allow an http:// issuer (tests and local mock providers only). */
  allowInsecure: boolean;
}

/**
 * A firm's own Microsoft 365 directory (Entra ID workforce), through the
 * platform's multi-tenant app registration (ENTRA_WORKFORCE_CLIENT_ID/SECRET),
 * when the firm has set its tenant id.
 */
export function workforceSettings(firm: { ssoTenantId: string | null }): OidcSettings | null {
  const clientId = (process.env.ENTRA_WORKFORCE_CLIENT_ID || '').trim();
  if (!clientId || !firm.ssoTenantId) {
    return null;
  }
  const authority = (process.env.ENTRA_WORKFORCE_AUTHORITY || 'https://login.microsoftonline.com')
    .trim()
    .replace(/\/+$/, '');
  return {
    issuer: `${authority}/${firm.ssoTenantId}/v2.0`,
    clientId,
    clientSecret: (process.env.ENTRA_WORKFORCE_CLIENT_SECRET || '').trim(),
    label: 'Sign in with Microsoft 365',
    requireMfaClaim: flag('ENTRA_WORKFORCE_REQUIRE_MFA_CLAIM', false),
    allowInsecure: !isProduction() && flag('OIDC_ALLOW_INSECURE', false),
  };
}

/** Whether the platform's multi-tenant Microsoft 365 app is configured. */
export function workforceAvailable(): boolean {
  return Boolean((process.env.ENTRA_WORKFORCE_CLIENT_ID || '').trim());
}

/** Entra External ID (or any OIDC provider), when OIDC_ISSUER is set. */
export function oidcSettings(): OidcSettings | null {
  const issuer = (process.env.OIDC_ISSUER || '').trim();
  if (!issuer) {
    return null;
  }
  return {
    issuer,
    clientId: (process.env.OIDC_CLIENT_ID || '').trim(),
    clientSecret: (process.env.OIDC_CLIENT_SECRET || '').trim(),
    label: process.env.OIDC_LABEL || 'Sign in with Microsoft',
    requireMfaClaim: flag('OIDC_REQUIRE_MFA_CLAIM', false),
    allowInsecure: !isProduction() && flag('OIDC_ALLOW_INSECURE', false),
  };
}
