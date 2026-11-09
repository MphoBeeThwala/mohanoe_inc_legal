import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, codeForStep, timeStep, verifyCode } from '../lib/totp';

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238 appendix B, truncated to 6 digits.
    expect(codeForStep(secret, Math.floor(59 / 30))).toBe('287082');
    expect(codeForStep(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(codeForStep(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(codeForStep(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from('any carnal pleasure.');
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it('accepts one step of drift and returns the matched step', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    expect(verifyCode(secret, codeForStep(secret, step - 1), now)).toBe(step - 1);
    expect(verifyCode(secret, codeForStep(secret, step + 2), now)).toBeNull();
    expect(verifyCode(secret, 'abc123', now)).toBeNull();
  });
});
