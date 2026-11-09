
import './load-env';
import * as path from 'path';
import * as fs from 'fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { errorMessage, errorStatus } from './lib/http';
import routes from './routes';
import { assertConfig, configWarnings } from './config/env';
import { getPublicBranding } from './config/brand';
import { seedDefaultUsers } from './services/auth.service';
import {
  createRateLimiter,
  requestLogger,
  securityHeaders,
} from './middleware/security';

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
app.set('trust proxy', 1);

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
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'legal-practice-api',
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', (req, res) => {
  const configured = Boolean(
    process.env.JWT_SECRET &&
      (process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL) &&
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  res.json({
    status: configured ? 'ready' : 'degraded',
    configured,
    retentionDays: Number(process.env.CLIENT_DATA_RETENTION_DAYS || 3650),
    timestamp: new Date().toISOString(),
  });
});

// Public, pre-login branding for the white-label UI.
app.get('/api/tenant/branding', (req, res) => {
  res.json(getPublicBranding());
});

// Routes
app.use('/api', routes);

// The web app's production build (apps/web/dist), served on the same origin
// as the API. WEB_DIST_DIR overrides it for container images.
const frontendBuildCandidates = [
  process.env.WEB_DIST_DIR,
  path.resolve(__dirname, '..', '..', 'web', 'dist'),
].filter((candidate): candidate is string => Boolean(candidate));
const frontendBuildPath = frontendBuildCandidates.find((candidate) =>
  fs.existsSync(candidate),
);
if (frontendBuildPath) {
  app.use(express.static(frontendBuildPath));
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(frontendBuildPath, 'index.html'));
  });
} else {
  console.warn(
    `Frontend build not found. Checked: ${frontendBuildCandidates.join(', ')}`,
  );
}

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const statusCode = errorStatus(error);
  if (statusCode >= 500) {
    console.error(
      JSON.stringify({
        requestId: req.requestId,
        message: errorMessage(error),
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
  try {
    assertConfig();
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
  configWarnings().forEach((warning) => console.warn(`WARNING: ${warning}`));

  if (String(process.env.SEED_ADMIN_ON_STARTUP || '').toLowerCase() === 'true') {
    seedDefaultUsers().catch((error) => {
      console.error('Admin seed on startup failed:', error.message);
    });
  }

  app.listen(port, () => {
    console.log(`Legal practice API listening at http://localhost:${port}`);
  });
}

export default app;
