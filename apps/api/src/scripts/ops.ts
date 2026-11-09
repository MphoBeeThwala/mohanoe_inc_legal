// Platform operations for Ahava on 88 staff: encryption keys and audit anchors.
//
//   npm run ops -w apps/api -- keys status   [--slug <slug>]
//   npm run ops -w apps/api -- keys rotate   --slug <slug>
//   npm run ops -w apps/api -- keys reencrypt [--slug <slug>]
//   npm run ops -w apps/api -- keys rewrap   [--slug <slug>]
//   npm run ops -w apps/api -- keys prune    [--slug <slug>]
//   npm run ops -w apps/api -- anchor
//
// Without --slug, key commands run for every firm. Needs the same
// DATABASE_URL, secrets and KEY_PROVIDER settings as the server; run
// `npm run build` first.
import '../load-env';
import { parseArgs } from 'node:util';
import { closeDb, initDb } from '../db/client';
import { withTenant } from '../db/tenant';
import type { FirmRow } from '../db/schema';
import { describeError } from '../lib/http';
import { findFirmBySlug, listFirms } from '../services/firm.service';
import { listKeys, rewrapKeys, rotateDataKey } from '../services/keys.service';
import {
  pendingReencryption,
  pruneRetiredKeys,
  reencryptFirm,
} from '../services/reencrypt.service';
import { anchorAllFirms } from '../services/audit-anchor.service';
import * as auditService from '../services/audit.service';

const OPERATOR = { fullName: 'Platform operations', role: 'system' };

async function targetFirms(slug?: string): Promise<FirmRow[]> {
  if (!slug) {
    return listFirms();
  }
  const firm = await findFirmBySlug(slug);
  if (!firm) {
    throw new Error(`No firm with slug ${slug}`);
  }
  return [firm];
}

const asSystem = <T>(firm: FirmRow, fn: () => Promise<T>) => withTenant(firm, fn, { system: true });

async function keys(action: string, slug?: string): Promise<void> {
  if (action === 'rotate' && !slug) {
    throw new Error('keys rotate needs --slug');
  }
  for (const firm of await targetFirms(slug)) {
    if (action === 'status') {
      const [rows, status] = await asSystem(
        firm,
        async () => [await listKeys(), await pendingReencryption()] as const,
      );
      const described = rows
        .map((row) => `${row.purpose} v${row.version} ${row.status} (${row.kekProvider})`)
        .join(', ');
      console.log(`${firm.slug}: ${described || 'no keys yet (created on first use)'}`);
      console.log(
        `  not yet on data key v${status.activeVersion}: ${JSON.stringify(status.pending)}`,
      );
    } else if (action === 'rotate') {
      const version = await asSystem(firm, async () => {
        const next = await rotateDataKey();
        await auditService.logEvent(
          {
            entityType: 'firm',
            entityId: firm.id,
            action: 'data_key_rotated',
            summary: `Encryption key rotated to version ${next}`,
          },
          OPERATOR,
        );
        return next;
      });
      console.log(
        `${firm.slug}: data key v${version} active. Now run: keys reencrypt --slug ${firm.slug}`,
      );
    } else if (action === 'reencrypt') {
      const done = await reencryptFirm(firm);
      await asSystem(firm, () =>
        auditService.logEvent(
          {
            entityType: 'firm',
            entityId: firm.id,
            action: 'data_reencrypted',
            summary: 'Encrypted data moved to the active key',
            details: done,
          },
          OPERATOR,
        ),
      );
      console.log(`${firm.slug}: re-encrypted ${JSON.stringify(done)}`);
    } else if (action === 'rewrap') {
      const changed = await asSystem(firm, () => rewrapKeys());
      console.log(`${firm.slug}: re-wrapped ${changed} key(s) with the current key-encryption key`);
    } else if (action === 'prune') {
      const pruned = await asSystem(firm, () => pruneRetiredKeys());
      console.log(
        `${firm.slug}: ${pruned.length ? `deleted retired key version(s) ${pruned.join(', ')}` : 'nothing to prune'}`,
      );
    } else {
      throw new Error(`Unknown keys action "${action}"`);
    }
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    options: { slug: { type: 'string' } },
    allowPositionals: true,
  });
  await initDb();
  if (command === 'keys') {
    await keys(positionals[0] ?? 'status', values.slug);
  } else if (command === 'anchor') {
    for (const result of await anchorAllFirms()) {
      console.log(`${result.firm}: ${result.anchored ? 'anchored' : 'no new events'}`);
    }
  } else {
    throw new Error(
      'Usage: ops keys status|rotate|reencrypt|rewrap|prune [--slug <slug>] | ops anchor',
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
