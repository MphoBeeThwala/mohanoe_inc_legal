// Encryption of client personal information, and redaction for AI briefs.
//
// Ciphertext format:
//   v2:<key version>:<iv>:<tag>:<ciphertext>  AES-256-GCM with the firm's data
//       key (keys.service.ts), authenticated with the firm id, so a value
//       copied into another firm's rows does not decrypt.
//   v1:<iv>:<tag>:<ciphertext>  legacy, one global INTAKE_ENCRYPTION_KEY.
//       Still readable; `ops keys reencrypt` moves it to v2.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { currentFirm } from '../db/tenant-context';
import { activeKey, keyVersion, legacyKey } from './keys.service';

function firmAad(): Buffer {
  return Buffer.from(`firm:${currentFirm().id}`);
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

function hmacHex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value.trim().toLowerCase()).digest('hex');
}

/**
 * Deterministic keyed hash of an identifier (e.g. an email address), so
 * records can be found by it without storing it in plaintext. Keyed with the
 * firm's index key, so the same email gives different values in different
 * firms.
 */
async function blindIndex(value: string): Promise<string> {
  const { key } = await activeKey('index');
  return hmacHex(key, value);
}

/** Legacy (pre-firm-key) blind index, for rows not yet re-encrypted. */
function legacyBlindIndex(value: string): string | null {
  const key = legacyKey();
  if (!key) {
    return null;
  }
  const lookupKey = createHash('sha256')
    .update(Buffer.concat([Buffer.from('blind-index:v1:'), key]))
    .digest();
  return hmacHex(lookupKey, value);
}

/** Every blind-index value a stored row might carry for this identifier. */
async function blindIndexCandidates(value: string): Promise<string[]> {
  const current = await blindIndex(value);
  const legacy = legacyBlindIndex(value);
  return legacy && legacy !== current ? [current, legacy] : [current];
}

async function encryptJson(value: unknown): Promise<string> {
  const { version, key } = await activeKey('data');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(firmAad());
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
  ]);
  return [
    'v2',
    String(version),
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/** The data-key version a v2 payload uses (null for legacy v1). */
function payloadKeyVersion(payload: string): number | null {
  const [format, version] = payload.split(':');
  return format === 'v2' ? Number(version) : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function decryptJson<T = any>(payload: string | null | undefined): Promise<T | null> {
  if (!payload) {
    return null;
  }
  const parts = String(payload).split(':');
  let key: Buffer;
  let ivBase64: string | undefined;
  let tagBase64: string | undefined;
  let bodyBase64: string | undefined;
  let aad: Buffer | null = null;
  if (parts[0] === 'v2') {
    key = await keyVersion('data', Number(parts[1]));
    [, , ivBase64, tagBase64, bodyBase64] = parts;
    aad = firmAad();
  } else if (parts[0] === 'v1') {
    const legacy = legacyKey();
    if (!legacy) {
      throw new Error('INTAKE_ENCRYPTION_KEY is needed to read data written before per-firm keys');
    }
    key = legacy;
    [, ivBase64, tagBase64, bodyBase64] = parts;
  } else {
    throw new Error('Unsupported encrypted payload version');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivBase64 ?? '', 'base64'));
  if (aad) {
    decipher.setAAD(aad);
  }
  decipher.setAuthTag(Buffer.from(tagBase64 ?? '', 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(bodyBase64 ?? '', 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

export {
  blindIndex,
  blindIndexCandidates,
  decryptJson,
  encryptJson,
  legacyBlindIndex,
  payloadKeyVersion,
  redactMatterForAi,
  redactText,
};
