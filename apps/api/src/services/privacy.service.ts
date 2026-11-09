import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';

import { isProduction } from '../config/env';

const FALLBACK_KEY = createHash('sha256').update('local-development-intake-key').digest();

function getEncryptionKey(): Buffer {
  const keySource = process.env.INTAKE_ENCRYPTION_KEY || process.env.PII_ENCRYPTION_KEY;

  if (!keySource) {
    if (isProduction()) {
      throw new Error('INTAKE_ENCRYPTION_KEY must be set in production');
    }
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

export interface RedactionHints {
  clientName?: string;
  fullName?: string;
}

/** Narrative fields that may contain PII; only redacted output leaves the server. */
export interface MatterNarrative {
  fullName?: string;
  practiceArea?: string;
  jurisdiction?: string;
  urgencyHint?: string;
  matterSummary?: string;
  contextNotes?: string;
  requestedOutcome?: string;
  documentsMentioned?: string;
}

export interface RedactedBrief {
  clientLabel: string;
  practiceArea: string;
  jurisdiction: string;
  urgencyHint: string;
  matterSummary: string;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactText(text: string | null | undefined, metadata: RedactionHints = {}): string {
  if (!text) {
    return '';
  }

  const replacements: Array<[RegExp, string]> = [
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

function redactMatterForAi(payload: MatterNarrative): RedactedBrief {
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

/**
 * Deterministic keyed hash of an identifier (e.g. an email address), so
 * records can be found by it without storing it in plaintext. Uses a key
 * derived from the encryption key, so it cannot be reversed or recomputed
 * without that key.
 */
function blindIndex(value: string): string {
  const lookupKey = createHash('sha256')
    .update(Buffer.concat([Buffer.from('blind-index:v1:'), getEncryptionKey()]))
    .digest();
  return createHmac('sha256', lookupKey).update(value.trim().toLowerCase()).digest('hex');
}

function encryptJson(value: unknown): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(
    ':',
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decryptJson<T = any>(payload: string | null | undefined): T | null {
  if (!payload) {
    return null;
  }

  const [version, ivBase64, tagBase64, encryptedBase64] = String(payload).split(':');

  if (version !== 'v1') {
    throw new Error('Unsupported encrypted payload version');
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivBase64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

export { decryptJson, encryptJson, redactMatterForAi, redactText, blindIndex };
