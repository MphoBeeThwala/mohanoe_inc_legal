// Object storage for document bodies and audit anchors.
//
// OBJECT_STORE selects the backend:
//   (unset)      document bodies stay (encrypted) in PostgreSQL; audit anchors
//                are kept in the database only.
//   filesystem   files under OBJECT_STORE_DIR (development and tests).
//   azure-blob   Azure Blob Storage: AZURE_STORAGE_ACCOUNT_URL with managed
//                identity, or AZURE_STORAGE_CONNECTION_STRING (e.g. Azurite).
//                Documents go to one container per firm; anchors to
//                AUDIT_ANCHOR_CONTAINER, which should have a time-based
//                immutability (WORM) policy set in infrastructure.
//
// Everything written here is already encrypted or contains no personal
// information; the store adds no encryption of its own beyond the provider's.
import { promises as fs } from 'fs';
import * as path from 'path';

export interface ObjectStore {
  readonly kind: 'filesystem' | 'azure-blob';
  put(
    container: string,
    key: string,
    body: Buffer,
    options?: { overwrite?: boolean },
  ): Promise<void>;
  get(container: string, key: string): Promise<Buffer>;
  delete(container: string, key: string): Promise<void>;
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._/-]*$/i;

function assertSafe(container: string, key: string): void {
  if (!/^[a-z0-9-]{3,63}$/.test(container) || !SAFE_SEGMENT.test(key) || key.includes('..')) {
    throw new Error('Invalid object location');
  }
}

class FilesystemStore implements ObjectStore {
  readonly kind = 'filesystem' as const;

  constructor(private readonly root: string) {}

  private file(container: string, key: string): string {
    assertSafe(container, key);
    return path.join(this.root, container, key);
  }

  async put(container: string, key: string, body: Buffer, options: { overwrite?: boolean } = {}) {
    const file = this.file(container, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, { flag: options.overwrite === false ? 'wx' : 'w' });
  }

  async get(container: string, key: string) {
    return fs.readFile(this.file(container, key));
  }

  async delete(container: string, key: string) {
    await fs.rm(this.file(container, key), { force: true });
  }
}

class AzureBlobStore implements ObjectStore {
  readonly kind = 'azure-blob' as const;
  private readonly service: import('@azure/storage-blob').BlobServiceClient;
  private readonly ensured = new Set<string>();

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const blob = require('@azure/storage-blob') as typeof import('@azure/storage-blob');
    const connectionString = (process.env.AZURE_STORAGE_CONNECTION_STRING || '').trim();
    if (connectionString) {
      this.service = blob.BlobServiceClient.fromConnectionString(connectionString);
    } else {
      const url = (process.env.AZURE_STORAGE_ACCOUNT_URL || '').trim();
      if (!url) {
        throw new Error(
          'OBJECT_STORE=azure-blob needs AZURE_STORAGE_ACCOUNT_URL (managed identity) or AZURE_STORAGE_CONNECTION_STRING',
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DefaultAzureCredential } =
        require('@azure/identity') as typeof import('@azure/identity');
      this.service = new blob.BlobServiceClient(url, new DefaultAzureCredential());
    }
  }

  private async container(name: string) {
    const client = this.service.getContainerClient(name);
    if (!this.ensured.has(name)) {
      await client.createIfNotExists();
      this.ensured.add(name);
    }
    return client;
  }

  async put(container: string, key: string, body: Buffer, options: { overwrite?: boolean } = {}) {
    assertSafe(container, key);
    const client = (await this.container(container)).getBlockBlobClient(key);
    await client.uploadData(body, {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
      // overwrite: false refuses to replace an existing blob.
      conditions: options.overwrite === false ? { ifNoneMatch: '*' } : undefined,
    });
  }

  async get(container: string, key: string) {
    assertSafe(container, key);
    return (await this.container(container)).getBlockBlobClient(key).downloadToBuffer();
  }

  async delete(container: string, key: string) {
    assertSafe(container, key);
    await (await this.container(container)).getBlockBlobClient(key).deleteIfExists();
  }
}

let store: ObjectStore | null | undefined;

/** The configured store, or null when OBJECT_STORE is unset. */
export function objectStore(): ObjectStore | null {
  if (store === undefined) {
    const kind = (process.env.OBJECT_STORE || '').trim();
    if (!kind) {
      store = null;
    } else if (kind === 'filesystem') {
      store = new FilesystemStore(
        path.resolve(process.env.OBJECT_STORE_DIR || path.join(process.cwd(), '.data', 'objects')),
      );
    } else if (kind === 'azure-blob') {
      store = new AzureBlobStore();
    } else {
      throw new Error(`Unknown OBJECT_STORE "${kind}" (use filesystem or azure-blob)`);
    }
  }
  return store;
}

/** Test hook: re-read OBJECT_STORE on next use. */
export function resetObjectStore(): void {
  store = undefined;
}

/** A firm's document container: one per firm, named from its id. */
export function firmContainer(firmId: string): string {
  return `firm-${firmId.replace(/-/g, '')}`;
}

export function anchorContainer(): string {
  return (process.env.AUDIT_ANCHOR_CONTAINER || 'audit-anchors').trim();
}
