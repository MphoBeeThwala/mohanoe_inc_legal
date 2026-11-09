import './load-env';
import * as path from 'path';
import * as fs from 'fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { describeError, errorMessage, errorStatus } from './lib/http';
import { flushMonitoring, initMonitoring, reportError } from './lib/monitoring';
import routes from './routes';
import { assertConfig, configWarnings } from './config/env';
import { getPublicBranding } from './config/brand';
import { closeDb, dbDriver, initDb, pingDb } from './db/client';
import { tenantContext } from './middleware/tenant';
import { ensureDefaultFirm } from './services/firm.service';
import { scheduleAnchoring } from './services/audit-anchor.service';
import { scheduleReminders } from './services/calendar.service';
import { sendError } from './lib/http';
import { scheduleCourtRollSync } from './services/court-roll.service';
import { domainCheckValue, readAsset } from './services/white-label.service';
import * as supportService from './services/support.service';
import { createRateLimiter, requestLogger, securityHeaders } from './middleware/security';
import { frontDoorGuard } from './middleware/front-door';

const app = express();
const port = process.env.PORT || 3001;
const appOrigin =
  process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
const allowedOrigins = new Set(
  [appOrigin, 'http://localhost:3000', 'http://localhost:3001']
    .map((origin) => origin && origin.trim())
    .filter(Boolean),
);

app.disable('x-powered-by');
// Proxies in front of the app: 1 by default (Container Apps ingress); 2
// behind Azure Front Door, so rate limits see the client's address.
app.set('trust proxy', Math.max(0, Number(process.env.TRUST_PROXY_HOPS ?? 1) || 0));

// Middleware
app.use(securityHeaders);
app.use(requestLogger);
const rateLimiter = createRateLimiter();
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    rateLimiter(req, res, next);
    return;
  }

  next();
});
app.use(
  cors({
    // Only listed origins get CORS headers (development front ends). Others
    // get none, so browsers block cross-origin reads; same-origin requests
    // from any firm's domain don't need CORS. Writes from foreign origins are
    // refused by the session CSRF check (auth.service.ts).
    origin(origin, callback) {
      callback(null, Boolean(origin && allowedOrigins.has(origin)));
    },
    credentials: true,
  }),
);
// JSON bodies: 1 MB, except file uploads (base64 files up to 10 MB): FICA
// documents, court rolls, and the firm's logo and icon.
const smallJson = express.json({ limit: '1mb' });
const uploadJson = express.json({ limit: '14mb' });
const UPLOAD_PATHS = [
  /^\/api\/clients\/[^/]+\/fica\/documents\/?$/,
  /^\/api\/court-rolls\/upload\/?$/,
  /^\/api\/firm\/assets\/(logo|icon)\/?$/,
];
app.use((req, res, next) =>
  (req.method === 'POST' || req.method === 'PUT') &&
  UPLOAD_PATHS.some((path) => path.test(req.path))
    ? uploadJson(req, res, next)
    : smallJson(req, res, next),
);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'legal-practice-api',
    timestamp: new Date().toISOString(),
  });
});

// Readiness: 503 until the database answers, so load balancers and
// deploys wait for a working instance.
app.get('/ready', async (req, res) => {
  const database = await pingDb();
  const configured = Boolean(
    process.env.JWT_SECRET && (process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL),
  );

  res.status(database ? 200 : 503).json({
    status: database && configured ? 'ready' : database ? 'degraded' : 'unavailable',
    database,
    configured,
    retentionDays: Number(process.env.CLIENT_DATA_RETENTION_DAYS || 3650),
    timestamp: new Date().toISOString(),
  });
});

// Behind Azure Front Door (FRONT_DOOR_ID set), only requests that came through
// our Front Door profile are served, so its firewall can't be bypassed by
// calling the container app's own address. Health probes come from the
// platform directly and stay open.
app.use(frontDoorGuard());

// Platform support sign-in checks the operator outside any firm's transaction,
// then the firm's grant inside it (support.service.ts).
const supportSignInLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
});
app.post('/api/support/sign-in', supportSignInLimiter, (req, res) => {
  supportService.signInHandler(req, res);
});

// Custom-domain check: only this platform can answer for a host (see
// white-label.service). No firm or database involved.
app.get('/.well-known/firm-domain-check', (req, res) => {
  res.type('text/plain').send(domainCheckValue(req.hostname));
});

// Every /api request belongs to one firm, resolved from the host name, and
// runs inside that firm's row-level-security context.
app.use('/api', tenantContext());

// Public, pre-login branding for the white-label UI.
app.get('/api/tenant/branding', (req, res) => {
  res.json(getPublicBranding(req.firm!));
});
for (const kind of ['logo', 'icon'] as const) {
  app.get(`/api/tenant/${kind}`, async (req, res) => {
    try {
      const asset = await readAsset(kind);
      if (!asset) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      // Versioned URLs (?v=hash) can be cached for long.
      res.setHeader(
        'Cache-Control',
        req.query.v === asset.contentHash.slice(0, 16)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300',
      );
      res.status(200).send(asset.content);
    } catch (error) {
      sendError(res, error);
    }
  });
}

// Routes
app.use('/api', routes);

// The web app's production build (apps/web/dist), served on the same origin
// as the API. WEB_DIST_DIR overrides it for container images.
const frontendBuildCandidates = [
  process.env.WEB_DIST_DIR,
  path.resolve(__dirname, '..', '..', 'web', 'dist'),
].filter((candidate): candidate is string => Boolean(candidate));
const frontendBuildPath = frontendBuildCandidates.find((candidate) => fs.existsSync(candidate));
if (frontendBuildPath) {
  app.use(express.static(frontendBuildPath));
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(frontendBuildPath, 'index.html'));
  });
} else {
  console.warn(`Frontend build not found. Checked: ${frontendBuildCandidates.join(', ')}`);
}

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const statusCode = errorStatus(error);
  if (statusCode >= 500) {
    reportError(error, { requestId: req.requestId, path: req.originalUrl });
    console.error(
      JSON.stringify({
        requestId: req.requestId,
        error: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
  }

  // Never leak internal error details (database messages, stack hints) to
  // clients in production; they are in the server log under the request ID.
  const exposeMessage = statusCode < 500 || process.env.NODE_ENV !== 'production';
  res.status(statusCode).json({
    message: exposeMessage ? errorMessage(error) : 'Internal server error',
    requestId: req.requestId,
  });
});

if (require.main === module) {
  initMonitoring();
  try {
    assertConfig();
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
  configWarnings().forEach((warning) => console.warn(`WARNING: ${warning}`));

  initDb()
    .then(async () => {
      console.log(`Database connected (${dbDriver()}); migrations applied.`);
      const defaultFirm = await ensureDefaultFirm();
      if (defaultFirm) {
        console.log(`Default firm: ${defaultFirm.slug} (${defaultFirm.legalName})`);
      }

      scheduleAnchoring();
      scheduleReminders();
      scheduleCourtRollSync();
      const server = app.listen(port, () => {
        console.log(`Legal practice API listening at http://localhost:${port}`);
      });

      const shutdown = (signal: string) => {
        console.log(`${signal} received: closing connections.`);
        server.close(() => {
          Promise.allSettled([closeDb(), flushMonitoring()]).finally(() => process.exit(0));
        });
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((error: unknown) => {
      console.error(`Refusing to start: database unavailable: ${describeError(error)}`);
      process.exit(1);
    });
}

export default app;
