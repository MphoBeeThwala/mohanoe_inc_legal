// Error monitoring (Sentry), when SENTRY_DSN is set.
//
// Only unexpected errors (5xx) are sent, and nothing that could carry
// personal information: no request bodies, query strings, cookies, headers,
// user details or breadcrumbs, and no performance tracing. What remains is
// the error type, a scrubbed message, the stack and the request path.
import * as Sentry from '@sentry/node';

let enabled = false;

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const ID_NUMBER = /\b\d{13}\b/g;
const LONG_DIGITS = /\b\d{6,}\b/g;

/** Removes things that look like personal information from free text. */
export function scrub(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(ID_NUMBER, '[id-number]')
    .replace(LONG_DIGITS, '[number]');
}

export function initMonitoring(): boolean {
  const dsn = (process.env.SENTRY_DSN || '').trim();
  if (!dsn || enabled) return enabled;
  Sentry.init({
    dsn,
    environment: process.env.DEPLOY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.APP_RELEASE || undefined,
    // Collect nothing about people or requests (beforeSend scrubs the rest).
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    beforeSend(event) {
      if (event.request) {
        event.request = {
          method: event.request.method,
          url: event.request.url?.split('?')[0],
        };
      }
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      if (event.message) event.message = scrub(event.message);
      for (const exception of event.exception?.values ?? []) {
        if (exception.value) exception.value = scrub(exception.value);
      }
      return event;
    },
  });
  enabled = true;
  return enabled;
}

/** Reports an unexpected error; returns a reference to give the user. */
export function reportError(error: unknown, context: { requestId?: string; path?: string } = {}) {
  if (!enabled) return null;
  return Sentry.captureException(error, {
    tags: { requestId: context.requestId ?? 'none', path: context.path?.split('?')[0] ?? 'none' },
  });
}

export async function flushMonitoring(timeoutMs = 2_000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}
