import { randomUUID } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs?: number;
  max?: number;
}

function createRateLimiter(options: RateLimitOptions = {}): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const windowMs = options.windowMs || Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
  const maxRequests = options.max || Number(process.env.RATE_LIMIT_MAX || 240);

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

// The web app is a same-origin bundle: no inline scripts, no third-party
// scripts. Inline styles are allowed (React style attributes for branding);
// images may come from a firm's logo URL (https) or data: (MFA QR codes).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  req.requestId = req.requestId || randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    // Browsers only honour HSTS over HTTPS (Front Door terminates TLS).
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
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

export { createRateLimiter, requestLogger, securityHeaders };
