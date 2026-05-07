
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { seedDefaultUsers } = require('./services/auth.service');

const app = express();
const port = process.env.PORT || 3001;
const appOrigin = process.env.APP_ORIGIN || 'http://localhost:3000';
const allowedOrigins = new Set(
  [appOrigin, 'http://localhost:3000', 'http://localhost:3001']
    .map((origin) => origin && origin.trim())
    .filter(Boolean),
);

// Middleware
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

// Routes
app.use('/api', routes);

const frontendBuildCandidates = [
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
}

if (require.main === module) {
  seedDefaultUsers().catch(() => {});
  app.listen(port, () => {
    console.log(`Mohanoe backend listening at http://localhost:${port}`);
  });
}

module.exports = app;
