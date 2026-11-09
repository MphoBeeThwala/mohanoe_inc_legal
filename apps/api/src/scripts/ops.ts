// Platform operations for Ahava on 88 staff: encryption keys and audit anchors.
//
//   npm run ops -w apps/api -- keys status   [--slug <slug>]
//   npm run ops -w apps/api -- keys rotate   --slug <slug>
//   npm run ops -w apps/api -- keys reencrypt [--slug <slug>]
//   npm run ops -w apps/api -- keys rewrap   [--slug <slug>]
//   npm run ops -w apps/api -- keys prune    [--slug <slug>]
//   npm run ops -w apps/api -- anchor
//   npm run ops -w apps/api -- operator create --email <email> --name "<name>"
//   npm run ops -w apps/api -- operator list | disable --email <email> | enable --email <email>
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
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { sendRemindersForAllFirms } from '../services/calendar.service';
import { restoreCheck } from '../services/restore-check.service';
import { importRollFile, syncCourtRolls } from '../services/court-roll.service';
import { checkPendingDomains } from '../services/white-label.service';
import { anchorAllFirms } from '../services/audit-anchor.service';
import { createOperator, listOperators, setOperatorActive } from '../services/support.service';
import * as auditService from '../services/audit.service';
import * as subscriptions from '../services/subscription.service';

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

async function operators(action: string, email?: string, name?: string): Promise<void> {
  if (action === 'list') {
    for (const op of await listOperators()) {
      console.log(`${op.email.padEnd(36)} ${op.isActive ? 'active  ' : 'disabled'} ${op.fullName}`);
    }
    return;
  }
  if (!email) {
    throw new Error(`operator ${action} needs --email`);
  }
  if (action === 'create') {
    const created = await createOperator({ email, fullName: name || email });
    console.log(`Support operator created: ${created.email}`);
    console.log(`One-time password: ${created.password}`);
    console.log(`Authenticator key: ${created.secret}`);
    console.log(`Authenticator link: ${created.otpauthUrl}`);
    console.log(
      'Hand these over in person or through a password manager; they are not shown again.',
    );
  } else if (action === 'disable' || action === 'enable') {
    const found = await setOperatorActive(email, action === 'enable');
    console.log(found ? `${email}: ${action}d` : `No operator ${email}`);
  } else {
    throw new Error(`Unknown operator action "${action}"`);
  }
}

const rands = (cents: number) => `R${(cents / 100).toFixed(2)}`;

async function plans(action: string, values: Record<string, string | undefined>): Promise<void> {
  if (action === 'list') {
    for (const plan of await subscriptions.listAllPlans()) {
      console.log(
        `${plan.code.padEnd(16)} ${plan.isActive ? 'active  ' : 'retired '} ${plan.name}: ${rands(plan.monthlySeatPriceCents)}/seat/month, ${rands(plan.annualSeatPriceCents)}/seat/year (excl. VAT), seats ${plan.minSeats}-${plan.maxSeats ?? 'any'}`,
      );
    }
  } else if (action === 'set') {
    const saved = await subscriptions.upsertPlan({
      code: values.code,
      name: values.name,
      description: values.description,
      monthlySeatPriceCents: values.monthly,
      annualSeatPriceCents: values.annual,
      minSeats: values['min-seats'],
      maxSeats: values['max-seats'] ?? null,
      sortOrder: values.order,
    });
    console.log(`Plan ${saved.code} saved.`);
  } else if (action === 'disable') {
    if (!values.code) throw new Error('plans disable needs --code');
    console.log(
      (await subscriptions.disablePlan(values.code))
        ? `${values.code}: retired`
        : `No plan ${values.code}`,
    );
  } else {
    throw new Error(`Unknown plans action "${action}"`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      slug: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      file: { type: 'string' },
      division: { type: 'string' },
      title: { type: 'string' },
      code: { type: 'string' },
      description: { type: 'string' },
      monthly: { type: 'string' },
      annual: { type: 'string' },
      'min-seats': { type: 'string' },
      'max-seats': { type: 'string' },
      order: { type: 'string' },
      until: { type: 'string' },
      seats: { type: 'string' },
    },
    allowPositionals: true,
  });
  await initDb();
  if (command === 'keys') {
    await keys(positionals[0] ?? 'status', values.slug);
  } else if (command === 'plans') {
    await plans(positionals[0] ?? 'list', values as Record<string, string | undefined>);
  } else if (command === 'subscriptions') {
    for (const result of await subscriptions.checkAllSubscriptions()) {
      console.log(
        `${result.firm}: ${result.status}${result.changed ? ' (changed)' : ''}, ${result.emails} email(s)`,
      );
    }
  } else if (command === 'subscription') {
    if (positionals[0] !== 'comp' || !values.slug) {
      throw new Error(
        'Usage: ops subscription comp --slug <slug> [--until YYYY-MM-DD] [--seats N]',
      );
    }
    const until = values.until ? new Date(`${values.until}T23:59:59+02:00`) : null;
    if (until && Number.isNaN(until.getTime())) throw new Error('--until must be YYYY-MM-DD');
    const seats = values.seats ? Number(values.seats) : null;
    const [firm] = await targetFirms(values.slug);
    await asSystem(firm!, () => subscriptions.setComplimentary(until, seats));
    console.log(
      `${firm!.slug}: complimentary ${until ? `until ${values.until}` : 'with no end date'}`,
    );
  } else if (command === 'operator') {
    await operators(positionals[0] ?? 'list', values.email, values.name);
  } else if (command === 'anchor') {
    for (const result of await anchorAllFirms()) {
      console.log(`${result.firm}: ${result.anchored ? 'anchored' : 'no new events'}`);
    }
  } else if (command === 'court-rolls') {
    const report = values.file
      ? await importRollFile({
          division: values.division ?? '',
          title: values.title ?? basename(values.file),
          fileName: basename(values.file),
          body: await readFile(values.file),
        })
      : await syncCourtRolls();
    for (const source of report.sources) {
      console.log(
        `${source.division} ${source.url}: ${source.listed} listed, ${source.stored} new, ${source.unchanged} unchanged, ${source.failed} failed${source.skipped ? ` (${source.skipped})` : ''}${source.error ? ` (error: ${source.error})` : ''}`,
      );
    }
    console.log(
      `Matched ${report.matched} listing(s), flagged ${report.removed} removed, sent ${report.emails} email(s).`,
    );
  } else if (command === 'domains') {
    for (const result of await checkPendingDomains()) {
      console.log(
        `${result.firm} ${result.domain}: ${result.status}${result.error ? ` (${result.error})` : ''}`,
      );
    }
  } else if (command === 'restore-check') {
    const report = await restoreCheck();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } else if (command === 'reminders') {
    for (const result of await sendRemindersForAllFirms()) {
      console.log(`${result.firm}: ${result.events} event(s), ${result.emails} email(s)`);
    }
  } else {
    throw new Error(
      'Usage: ops keys status|rotate|reencrypt|rewrap|prune [--slug <slug>] | ops anchor | ops reminders | ops domains | ops restore-check | ops subscriptions | ops plans list|set|disable | ops subscription comp --slug <slug> | ops court-rolls [--file <roll> --division <code> --title <title>] | ops operator create|list|disable|enable',
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
