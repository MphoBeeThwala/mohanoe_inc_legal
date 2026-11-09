// Time-based one-time passwords (RFC 6238; HMAC-SHA1, 30 s steps, 6 digits),
// the format every authenticator app (Microsoft Authenticator, Google
// Authenticator, 1Password …) understands.
import crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error('Invalid base32 secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new 160-bit secret, base32-encoded. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function timeStep(at: number = Date.now()): number {
  return Math.floor(at / 1000 / STEP_SECONDS);
}

export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(binary).padStart(DIGITS, '0');
}

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matching step, so callers can refuse a step that was
 * already used (replay), or null.
 */
export function verifyCode(
  secret: string,
  code: string,
  at: number = Date.now(),
  window = 1,
): number | null {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) {
    return null;
  }
  const current = timeStep(at);
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    const expected = codeForStep(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) {
      return step;
    }
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
