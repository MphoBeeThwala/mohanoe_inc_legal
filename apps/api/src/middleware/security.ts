import { randomUUID } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

function createRateLimiter(): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
  const maxRequests = Number(process.env.RATE_LIMIT_MAX || 240);

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || String(req.headers['x-forwarded-for'] || 'unknown');
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

function securityHeaders(req: Request, res: Response, next: NextFunction): void {
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

function requestLogger(req: Request, res: Response, next: NextFunction): void {
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

export {
  createRateLimiter,
  requestLogger,
  securityHeaders,
};
