const { randomUUID } = require('crypto');

function createRateLimiter() {
  const buckets = new Map();
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
  const maxRequests = Number(process.env.RATE_LIMIT_MAX || 240);

  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - bucket.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));

    if (bucket.count > maxRequests) {
      res.status(429).json({
        message: 'Too many requests',
        requestId: req.requestId,
      });
      return;
    }

    next();
  };
}

function securityHeaders(req, res, next) {
  req.requestId = req.requestId || randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
}

function requestLogger(req, res, next) {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (process.env.LOG_HTTP === 'false') {
      return;
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs,
      }),
    );
  });

  next();
}

module.exports = {
  createRateLimiter,
  requestLogger,
  securityHeaders,
};
