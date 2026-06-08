const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} = require('crypto');

const FALLBACK_KEY = createHash('sha256')
  .update('mohanoe-legal-intake-development-key')
  .digest();

function getEncryptionKey() {
  const keySource =
    process.env.INTAKE_ENCRYPTION_KEY || process.env.PII_ENCRYPTION_KEY;

  if (!keySource) {
    return FALLBACK_KEY;
  }

  if (/^[0-9a-fA-F]{64}$/.test(keySource)) {
    return Buffer.from(keySource, 'hex');
  }

  try {
    const decoded = Buffer.from(keySource, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
  } catch (error) {
    // fall through to hashing
  }

  return createHash('sha256').update(keySource).digest();
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactText(text, metadata = {}) {
  if (!text) {
    return '';
  }

  const replacements = [
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]'],
    [/\b(?:\+27|0)[6-8]\d{8}\b/g, '[REDACTED PHONE]'],
    [/\b\d{13}\b/g, '[REDACTED ID]'],
    [/\b\d{16}\b/g, '[REDACTED NUMBER]'],
    [/\b\d{2}[\/.-]\d{2}[\/.-]\d{4}\b/g, '[REDACTED DATE]'],
  ];

  let output = String(text);

  const names = [metadata.clientName, metadata.fullName]
    .filter(Boolean)
    .map((value) => escapeRegExp(String(value).trim()))
    .filter(Boolean);

  names.forEach((name) => {
    const re = new RegExp(`\\b${name}\\b`, 'gi');
    output = output.replace(re, 'Client');
  });

  replacements.forEach(([pattern, replacement]) => {
    output = output.replace(pattern, replacement);
  });

  return output.replace(/\s+/g, ' ').trim();
}

function redactMatterForAi(payload) {
  const narrativeParts = [
    payload.matterSummary,
    payload.contextNotes,
    payload.requestedOutcome,
    payload.documentsMentioned,
  ]
    .filter(Boolean)
    .map((part) => String(part).trim());

  const combinedNarrative = narrativeParts.join('\n\n');

  return {
    clientLabel: 'Client A',
    practiceArea: payload.practiceArea || 'General legal matter',
    jurisdiction: payload.jurisdiction || 'South Africa',
    urgencyHint: payload.urgencyHint || 'unspecified',
    matterSummary: redactText(combinedNarrative, {
      clientName: payload.fullName,
      fullName: payload.fullName,
    }),
  };
}

function encryptJson(value) {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

function decryptJson(payload) {
  if (!payload) {
    return null;
  }

  const [version, ivBase64, tagBase64, encryptedBase64] = String(payload).split(
    ':',
  );

  if (version !== 'v1') {
    throw new Error('Unsupported encrypted payload version');
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivBase64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = {
  decryptJson,
  encryptJson,
  redactMatterForAi,
  redactText,
};
