// Firm (tenant) administration for Ahava on 88 staff.
//
//   npm run firm -w apps/api -- list
//   npm run firm -w apps/api -- create --slug nkosi --name "Nkosi & Partners Inc." \
//       [--trading-name Nkosi] [--prefix NKP] [--domain portal.nkosilaw.co.za] \
//       [--vat 4123456789] [--plan pilot] [--primary-color #1b7a58] \
//       [--admin-email partner@nkosilaw.co.za --admin-name "Thandi Nkosi"]
//
// Uses DATABASE_URL (or local PGlite) like the server. Run `npm run build` first.
// With --admin-email, prints a one-time password for the firm's first admin.

import '../load-env';
import { parseArgs } from 'node:util';
import { closeDb, initDb } from '../db/client';
import { createFirm, createFirmAdmin, listFirms } from '../services/firm.service';
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
      const admin = await createFirmAdmin(firm, {
        email: values['admin-email'],
        fullName: values['admin-name'] || 'Firm Administrator',
      });
      console.log(`Admin: ${admin.email}`);
      console.log(`One-time password: ${admin.password}`);
      console.log('Share it securely; the admin should change it after first sign-in.');
    }
    return;
  }

  throw new Error('Usage: firm list | firm create --slug <slug> --name <legal name> [options]');
}

main()
  .catch((error: unknown) => {
    console.error(describeError(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
