// Per-firm envelope encryption keys.
//
// Every firm has its own random 256-bit data keys (firm_keys). They are
// stored only wrapped by a key-encryption key (KEK):
//   - KEY_PROVIDER=azure-keyvault: an RSA key in Azure Key Vault
//     (AZURE_KEY_VAULT_KEY_ID), used through managed identity. The KEK never
//     leaves the vault; only wrap/unwrap calls are made.
//   - KEY_PROVIDER=local (default): AES-256-GCM with INTAKE_ENCRYPTION_KEY.
//     For development and interim hosting without Key Vault.
// Unwrapped data keys are cached in memory for a few minutes.
//
// purpose 'data' encrypts records and can be rotated (new version; old
// versions stay for decryption until `ops keys reencrypt` moves everything
// over). purpose 'index' keys blind indexes and is not rotated, so lookups
// keep working.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { devSecretsAllowed } from '../config/env';
import { db } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { firmKeys, type FirmKeyRow } from '../db/schema';

export type KeyPurpose = 'data' | 'index';

export interface WrappedKey {
  wrapped: string;
  kekId: string;
}

export interface KeyWrapper {
  readonly provider: string;
  wrap(key: Buffer): Promise<WrappedKey>;
  unwrap(wrapped: string, kekId: string): Promise<Buffer>;
}

// ---------------------------------------------------------------- local KEK

const DEV_KEY = createHash('sha256').update('local-development-intake-key').digest();

function keyFromSource(source: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(source)) {
    return Buffer.from(source, 'hex');
  }
  const decoded = Buffer.from(source, 'base64');
  if (decoded.length === 32) {
    return decoded;
  }
  return createHash('sha256').update(source).digest();
}

/**
 * INTAKE_ENCRYPTION_KEY: the local KEK, and the key of legacy (v1) ciphertext
 * written before per-firm keys. Null when unset outside development.
 */
export function legacyKey(): Buffer | null {
  const source = process.env.INTAKE_ENCRYPTION_KEY || process.env.PII_ENCRYPTION_KEY;
  if (source) {
    return keyFromSource(source);
  }
  return devSecretsAllowed() ? DEV_KEY : null;
}

function requireLegacyKey(): Buffer {
  const key = legacyKey();
  if (!key) {
    throw new Error(
      'INTAKE_ENCRYPTION_KEY must be set in production and whenever DATABASE_URL is set',
    );
  }
  return key;
}

function fingerprint(key: Buffer): string {
  return `local:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

const WRAP_AAD = Buffer.from('ahava88:firm-key:v1');

export const localWrapper: KeyWrapper = {
  provider: 'local',
  async wrap(key) {
    const kek = requireLegacyKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    cipher.setAAD(WRAP_AAD);
    const body = Buffer.concat([cipher.update(key), cipher.final()]);
    return {
      wrapped: [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64')).join('.'),
      kekId: fingerprint(kek),
    };
  },
  async unwrap(wrapped, kekId) {
    const candidates = [legacyKey(), previousLocalKey()].filter((key): key is Buffer =>
      Boolean(key),
    );
    const kek = candidates.find((candidate) => fingerprint(candidate) === kekId);
    if (!kek) {
      throw new Error(
        `Key ${kekId} was wrapped with a different INTAKE_ENCRYPTION_KEY. Set INTAKE_ENCRYPTION_KEY_PREVIOUS to the old value and run \`ops keys rewrap\`.`,
      );
    }
    const [iv, tag, body] = wrapped.split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', kek, iv!);
    decipher.setAAD(WRAP_AAD);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(body!), decipher.final()]);
  },
};

/** The previous local KEK, while rotating INTAKE_ENCRYPTION_KEY. */
function previousLocalKey(): Buffer | null {
  const source = process.env.INTAKE_ENCRYPTION_KEY_PREVIOUS;
  return source ? keyFromSource(source) : null;
}

// ---------------------------------------------------------------- Azure Key Vault KEK

/** The subset of @azure/keyvault-keys CryptographyClient used here. */
export interface KeyVaultCrypto {
  wrapKey(
    algorithm: 'RSA-OAEP-256',
    key: Uint8Array,
  ): Promise<{ result: Uint8Array; keyID?: string }>;
  unwrapKey(algorithm: 'RSA-OAEP-256', wrapped: Uint8Array): Promise<{ result: Uint8Array }>;
}

type CryptoFactory = (keyId: string) => KeyVaultCrypto;

let cryptoFactory: CryptoFactory | null = null;
const cryptoClients = new Map<string, KeyVaultCrypto>();

function defaultCryptoFactory(): CryptoFactory {
  // Loaded only when Key Vault is used. Managed identity in Azure;
  // developer credentials (az login) elsewhere.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DefaultAzureCredential } = require('@azure/identity') as typeof import('@azure/identity');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CryptographyClient } =
    require('@azure/keyvault-keys') as typeof import('@azure/keyvault-keys');
  const credential = new DefaultAzureCredential();
  return (keyId) => new CryptographyClient(keyId, credential) as unknown as KeyVaultCrypto;
}

function vaultCrypto(keyId: string): KeyVaultCrypto {
  let client = cryptoClients.get(keyId);
  if (!client) {
    cryptoFactory ??= defaultCryptoFactory();
    client = cryptoFactory(keyId);
    cryptoClients.set(keyId, client);
  }
  return client;
}

export const keyVaultWrapper: KeyWrapper = {
  provider: 'azure-keyvault',
  async wrap(key) {
    const keyId = (process.env.AZURE_KEY_VAULT_KEY_ID || '').trim();
    if (!keyId) {
      throw new Error('AZURE_KEY_VAULT_KEY_ID must be set when KEY_PROVIDER=azure-keyvault');
    }
    const result = await vaultCrypto(keyId).wrapKey('RSA-OAEP-256', key);
    // keyID includes the key version, so unwrapping keeps working after the
    // Key Vault key is rotated.
    return { wrapped: Buffer.from(result.result).toString('base64'), kekId: result.keyID || keyId };
  },
  async unwrap(wrapped, kekId) {
    const result = await vaultCrypto(kekId).unwrapKey(
      'RSA-OAEP-256',
      Buffer.from(wrapped, 'base64'),
    );
    return Buffer.from(result.result);
  },
};

/** Test hook: replace the Key Vault client (null restores the real one). */
export function setKeyVaultCryptoFactory(factory: CryptoFactory | null): void {
  cryptoFactory = factory;
  cryptoClients.clear();
}

const WRAPPERS: Record<string, KeyWrapper> = {
  local: localWrapper,
  'azure-keyvault': keyVaultWrapper,
};

/** The wrapper new keys are wrapped with (KEY_PROVIDER). */
export function currentWrapper(): KeyWrapper {
  const provider = (process.env.KEY_PROVIDER || 'local').trim();
  const wrapper = WRAPPERS[provider];
  if (!wrapper) {
    throw new Error(`Unknown KEY_PROVIDER "${provider}" (use local or azure-keyvault)`);
  }
  return wrapper;
}

function wrapperFor(provider: string): KeyWrapper {
  const wrapper = WRAPPERS[provider];
  if (!wrapper) {
    throw new Error(`Unknown key provider "${provider}"`);
  }
  return wrapper;
}

// ---------------------------------------------------------------- firm keys

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { key: Buffer; expires: number }>();

export function clearKeyCache(): void {
  cache.clear();
}

export interface FirmKey {
  version: number;
  key: Buffer;
}

async function unwrapRow(row: FirmKeyRow): Promise<Buffer> {
  const cacheKey = `${row.firmId}:${row.purpose}:${row.version}:${row.kekId}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return hit.key;
  }
  const key = await wrapperFor(row.kekProvider).unwrap(row.wrappedKey, row.kekId);
  if (key.length !== 32) {
    throw new Error('Unwrapped firm key has the wrong length');
  }
  cache.set(cacheKey, { key, expires: Date.now() + CACHE_TTL_MS });
  return key;
}

async function activeRow(purpose: KeyPurpose): Promise<FirmKeyRow | null> {
  const [row] = await db()
    .select()
    .from(firmKeys)
    .where(and(eq(firmKeys.purpose, purpose), eq(firmKeys.status, 'active')))
    .orderBy(desc(firmKeys.version))
    .limit(1);
  return row ?? null;
}

async function insertKey(purpose: KeyPurpose, version: number): Promise<void> {
  const wrapped = await currentWrapper().wrap(randomBytes(32));
  await db()
    .insert(firmKeys)
    .values({
      purpose,
      version,
      wrappedKey: wrapped.wrapped,
      kekProvider: currentWrapper().provider,
      kekId: wrapped.kekId,
    })
    .onConflictDoNothing();
}

/** The current firm's active key for a purpose, created on first use. */
export async function activeKey(purpose: KeyPurpose): Promise<FirmKey> {
  let row = await activeRow(purpose);
  if (!row) {
    await insertKey(purpose, 1);
    row = await activeRow(purpose);
  }
  if (!row) {
    throw new Error(`No ${purpose} key for firm ${currentFirm().slug}`);
  }
  return { version: row.version, key: await unwrapRow(row) };
}

/** A specific version of the current firm's key (for decryption). */
export async function keyVersion(purpose: KeyPurpose, version: number): Promise<Buffer> {
  const [row] = await db()
    .select()
    .from(firmKeys)
    .where(and(eq(firmKeys.purpose, purpose), eq(firmKeys.version, version)))
    .limit(1);
  if (!row) {
    throw new Error(`Encryption key version ${version} is missing for this firm`);
  }
  return unwrapRow(row);
}

/** Starts a new data-key version; the old one is kept for decryption. */
export async function rotateDataKey(): Promise<number> {
  const current = await activeRow('data');
  const next = (current?.version ?? 0) + 1;
  if (current) {
    await db()
      .update(firmKeys)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(eq(firmKeys.id, current.id));
  }
  await insertKey('data', next);
  return next;
}

/**
 * Re-wraps every key of the current firm with the current KEK: after rotating
 * the Key Vault key or INTAKE_ENCRYPTION_KEY, or moving from local to Key Vault.
 */
export async function rewrapKeys(): Promise<number> {
  const rows = await db().select().from(firmKeys);
  const wrapper = currentWrapper();
  let changed = 0;
  for (const row of rows) {
    const key = await unwrapRow(row);
    const wrapped = await wrapper.wrap(key);
    if (row.kekProvider === wrapper.provider && row.kekId === wrapped.kekId) {
      continue;
    }
    await db()
      .update(firmKeys)
      .set({ wrappedKey: wrapped.wrapped, kekProvider: wrapper.provider, kekId: wrapped.kekId })
      .where(eq(firmKeys.id, row.id));
    changed += 1;
  }
  clearKeyCache();
  return changed;
}

export async function listKeys(): Promise<FirmKeyRow[]> {
  return db().select().from(firmKeys).orderBy(firmKeys.purpose, firmKeys.version);
}

export async function deleteKey(id: string): Promise<void> {
  await db().delete(firmKeys).where(eq(firmKeys.id, id));
}
