// Only serve requests that came through our Azure Front Door profile.
//
// Front Door adds X-Azure-FDID (the profile's ID) to every request it
// forwards; a request without it, or with another profile's ID, went around
// the firewall. Off when FRONT_DOOR_ID is unset (development, tests).
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const OPEN_PATHS = new Set(['/health', '/ready']);

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function frontDoorGuard() {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = (process.env.FRONT_DOOR_ID || '').trim().toLowerCase();
    if (!expected || OPEN_PATHS.has(req.path)) {
      next();
      return;
    }
    const header = String(req.headers['x-azure-fdid'] || '')
      .trim()
      .toLowerCase();
    if (!header || !same(header, expected)) {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    next();
  };
}
