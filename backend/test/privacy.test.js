const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encryptJson,
  decryptJson,
  redactText,
} = require('../services/privacy.service');

test('encrypt/decrypt round-trips and never stores plaintext', () => {
  const record = { fullName: 'Thandi Nkosi', email: 'thandi@example.com' };
  const sealed = encryptJson(record);
  assert.ok(sealed.startsWith('v1:'));
  assert.ok(!sealed.includes('Thandi'));
  assert.deepEqual(decryptJson(sealed), record);
});

test('tampered ciphertext is rejected', () => {
  const sealed = encryptJson({ a: 1 });
  const parts = sealed.split(':');
  const body = Buffer.from(parts[3], 'base64');
  body[0] ^= 0xff;
  parts[3] = body.toString('base64');
  assert.throws(() => decryptJson(parts.join(':')));
});

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
