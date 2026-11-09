// Firm (tenant) administration for Ahava on 88 staff.
//
//   npm run firm -w apps/api -- list
//   npm run firm -w apps/api -- create --slug nkosi --name "Nkosi & Partners Inc." \
//       [--trading-name Nkosi] [--prefix NKP] [--domain portal.nkosilaw.co.za] \
//       [--vat 4123456789] [--plan pilot] [--primary-color #1b7a58] \
//       [--admin-email partner@nkosilaw.co.za --admin-name "Thandi Nkosi"]
//
//   npm run firm -w apps/api -- invite --slug nkosi --email it@nkosilaw.co.za \
//       --name "IT Admin"
//
// Uses DATABASE_URL (or local PGlite) like the server, with the same secrets.
// Run `npm run build` first. --admin-email / invite print an invitation link
// for an administrator (also emailed when SMTP_URL is set); the admin sets
// their own password and authenticator app when they accept it.

import '../load-env';
import { parseArgs } from 'node:util';
import { closeDb, initDb } from '../db/client';
import { createFirm, findFirmBySlug, inviteFirmAdmin, listFirms } from '../services/firm.service';
import type { FirmRow } from '../db/schema';
import { describeError } from '../lib/http';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  await initDb();

  if (command === 'list') {
    const firms = await listFirms();
    if (!firms.length) {
      console.log('No firms yet.');
    }
    for (const firm of firms) {
      const domains = firm.domains.length ? firm.domains.join(', ') : '-';
      console.log(
        `${firm.slug.padEnd(20)} ${firm.status.padEnd(10)} ${firm.casePrefix.padEnd(8)} ${firm.legalName}  [${domains}]`,
      );
    }
    return;
  }

  if (command === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        slug: { type: 'string' },
        name: { type: 'string' },
        'trading-name': { type: 'string' },
        prefix: { type: 'string' },
        domain: { type: 'string', multiple: true },
        vat: { type: 'string' },
        plan: { type: 'string' },
        'logo-url': { type: 'string' },
        'primary-color': { type: 'string' },
        'accent-color': { type: 'string' },
        'admin-email': { type: 'string' },
        'admin-name': { type: 'string' },
      },
    });
    if (!values.slug || !values.name) {
      throw new Error('create needs --slug and --name');
    }

    const firm = await createFirm({
      slug: values.slug,
      legalName: values.name,
      tradingName: values['trading-name'],
      casePrefix: values.prefix,
      domains: values.domain ?? [],
      vatNumber: values.vat,
      plan: values.plan,
      branding: {
        logoUrl: values['logo-url'],
        primaryColor: values['primary-color'],
        accentColor: values['accent-color'],
      },
    });
    console.log(`Created firm ${firm.slug} (${firm.id}), case prefix ${firm.casePrefix}.`);

    if (values['admin-email']) {
      await printInvite(firm, values['admin-email'], values['admin-name']);
    }
    return;
  }

  if (command === 'invite') {
    const { values } = parseArgs({
      args: rest,
      options: {
        slug: { type: 'string' },
        email: { type: 'string' },
        name: { type: 'string' },
      },
    });
    if (!values.slug || !values.email) {
      throw new Error('invite needs --slug and --email');
    }
    const firm = await findFirmBySlug(values.slug);
    if (!firm) {
      throw new Error(`No firm with slug ${values.slug}`);
    }
    await printInvite(firm, values.email, values.name);
    return;
  }

  throw new Error(
    'Usage: firm list | firm create --slug <slug> --name <legal name> [options] | firm invite --slug <slug> --email <email> [--name <name>]',
  );
}

async function printInvite(firm: FirmRow, email: string, name?: string): Promise<void> {
  const invite = await inviteFirmAdmin(firm, {
    email,
    fullName: name || 'Firm Administrator',
  });
  console.log(`Administrator invited: ${invite.email}`);
  console.log(`Invitation link (single use${invite.emailed ? ', also emailed' : ''}):`);
  console.log(invite.url);
  console.log('Share it securely. The admin sets a password and an authenticator app.');
}

main()
  .catch((error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
