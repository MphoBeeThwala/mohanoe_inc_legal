
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { seedDefaultUsers } = require('./services/auth.service');
const {
  createRateLimiter,
  requestLogger,
  securityHeaders,
} = require('./middleware/security');

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
    service: 'mohanoe-inc-legal-backend',
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

// Routes
app.use('/api', routes);

const frontendBuildCandidates = [
  path.resolve(__dirname, 'public'),
  path.resolve(__dirname, '..', 'frontend', 'build'),
  path.resolve(__dirname, '..', 'build'),
];
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

if (require.main === module) {
  seedDefaultUsers().catch((error) => {
    console.error('Default admin seed failed:', error.message);
  });
  app.listen(port, () => {
    console.log(`Mohanoe backend listening at http://localhost:${port}`);
  });
}

module.exports = app;
