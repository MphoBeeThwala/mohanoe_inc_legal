import { test } from 'vitest';
import assert from 'node:assert/strict';
import { encryptJson, decryptJson, redactText } from '../services/privacy.service';
import { inDefaultFirm } from './helpers';

test('encrypt/decrypt round-trips with the firm key and never stores plaintext', () =>
  inDefaultFirm(async () => {
    const record = { fullName: 'Thandi Nkosi', email: 'thandi@example.com' };
    const sealed = await encryptJson(record);
    assert.match(sealed, /^v2:1:/);
    assert.ok(!sealed.includes('Thandi'));
    assert.deepEqual(await decryptJson(sealed), record);
  }));

test('tampered ciphertext is rejected', () =>
  inDefaultFirm(async () => {
    const sealed = await encryptJson({ a: 1 });
    const parts = sealed.split(':');
    const body = Buffer.from(parts[4]!, 'base64');
    body[0] ^= 0xff;
    parts[4] = body.toString('base64');
    await assert.rejects(decryptJson(parts.join(':')));
  }));

test('redaction removes the client name, email, phone and SA ID number', () => {
  const output = redactText(
    'Thandi Nkosi (ID 8001015009087) can be reached at thandi@example.com or 0821234567.',
    { fullName: 'Thandi Nkosi' },
  );
  assert.ok(!output.includes('Thandi'));
  assert.ok(!output.includes('8001015009087'));
  assert.ok(!output.includes('thandi@example.com'));
  assert.ok(!output.includes('0821234567'));
  assert.match(output, /Client/);
});
