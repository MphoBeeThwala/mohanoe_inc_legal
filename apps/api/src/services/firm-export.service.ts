// Full export of one firm's data, for a firm leaving the platform (or a
// regulator's request). Run by Ahava on 88 staff with the firm CLI:
//   npm run firm -w apps/api -- export --slug <slug> --out <file.json>
// Personal information is decrypted (the export is the firm's own data);
// credentials and key material are left out.
import type { PgTable } from 'drizzle-orm/pg-core';
import { PLATFORM_LEGAL_NAME } from '@ahava88/shared';
import { db } from '../db/client';
import { withTenant } from '../db/tenant';
import * as schema from '../db/schema';
import type { FirmRow } from '../db/schema';
import { decryptJson } from './privacy.service';
import { readSealedContent } from './documents.service';
import { readSealedFica } from './fica.service';
import * as auditService from './audit.service';

/** Tables exported as they are (all rows of the firm). */
const PLAIN_TABLES: Record<string, PgTable> = {
  counters: schema.counters,
  assessments: schema.assessments,
  cases: schema.cases,
  caseMembers: schema.caseMembers,
  caseExclusions: schema.caseExclusions,
  caseParties: schema.caseParties,
  caseTasks: schema.caseTasks,
  caseTimeline: schema.caseTimeline,
  invoicePayments: schema.invoicePayments,
  ledgerEntries: schema.ledgerEntries,
  staffRates: schema.staffRates,
  matterRates: schema.matterRates,
  notifications: schema.notifications,
  auditEvents: schema.auditEvents,
  auditAnchors: schema.auditAnchors,
  reportSnapshots: schema.reportSnapshots,
  complianceRequests: schema.complianceRequests,
};

/** Left out: credentials, sessions and key material. */
export const EXCLUDED_TABLES = [
  'sessions',
  'mfaRecoveryCodes',
  'passwordResets',
  'firmKeys',
  'invites',
];

export interface FirmExport {
  format: 'ahava88-firm-export/v1';
  exportedAt: string;
  firm: FirmRow;
  tables: Record<string, unknown[]>;
}

export async function exportFirm(firm: FirmRow): Promise<FirmExport> {
  return withTenant(
    firm,
    async () => {
      const tables: Record<string, unknown[]> = {};
      for (const [name, table] of Object.entries(PLAIN_TABLES)) {
        tables[name] = await db().select().from(table);
      }

      tables.users = (await db().select().from(schema.users)).map((user) => ({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        isActive: user.isActive,
        signInMethods: [
          user.passwordHash ? 'password' : null,
          user.oidcSubject ? 'oidc' : null,
        ].filter(Boolean),
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      }));

      const submissions = await db().select().from(schema.submissions);
      tables.submissions = await Promise.all(
        submissions.map(async ({ rawPayloadEncrypted, emailLookup: _lookup, ...rest }) => ({
          ...rest,
          intake: await decryptJson(rawPayloadEncrypted),
        })),
      );

      const partyRows = await db().select().from(schema.parties);
      tables.parties = await Promise.all(
        partyRows.map(async ({ detailsEncrypted, ...rest }) => ({
          ...rest,
          details: await decryptJson(detailsEncrypted),
        })),
      );

      const profiles = await db().select().from(schema.ficaProfiles);
      tables.ficaProfiles = await Promise.all(
        profiles.map(async ({ notesEncrypted, ...rest }) => ({
          ...rest,
          notes: notesEncrypted ? await decryptJson(notesEncrypted) : null,
        })),
      );
      const kyc = await db().select().from(schema.ficaDocuments);
      tables.ficaDocuments = await Promise.all(
        kyc.map(async (row) => {
          const {
            fileNameEncrypted,
            encryptedContent: _sealed,
            storageKey: _key,
            contentKeyVersion: _v,
            ...rest
          } = row;
          return {
            ...rest,
            fileName: await decryptJson(fileNameEncrypted),
            dataBase64: await decryptJson(await readSealedFica(row)),
          };
        }),
      );

      const events = await db().select().from(schema.calendarEvents);
      tables.calendarEvents = await Promise.all(
        events.map(async ({ contentEncrypted, ...rest }) => ({
          ...rest,
          content: contentEncrypted ? await decryptJson(contentEncrypted) : null,
        })),
      );
      const periods = await db().select().from(schema.matterPrescriptions);
      tables.matterPrescriptions = await Promise.all(
        periods.map(async ({ notesEncrypted, ...rest }) => ({
          ...rest,
          notes: notesEncrypted ? await decryptJson(notesEncrypted) : null,
        })),
      );

      const bills = await db().select().from(schema.invoices);
      tables.invoices = await Promise.all(
        bills.map(async ({ contentEncrypted, ...rest }) => ({
          ...rest,
          content: contentEncrypted ? await decryptJson(contentEncrypted) : null,
        })),
      );
      const costs = await db().select().from(schema.disbursements);
      tables.disbursements = await Promise.all(
        costs.map(async ({ descriptionEncrypted, ...rest }) => ({
          ...rest,
          description: await decryptJson(descriptionEncrypted),
        })),
      );

      const entries = await db().select().from(schema.timeEntries);
      tables.timeEntries = await Promise.all(
        entries.map(async ({ descriptionEncrypted, ...rest }) => ({
          ...rest,
          description: await decryptJson(descriptionEncrypted),
        })),
      );
      const running = await db().select().from(schema.timers);
      tables.timers = await Promise.all(
        running.map(async ({ descriptionEncrypted, ...rest }) => ({
          ...rest,
          description: descriptionEncrypted ? await decryptJson(descriptionEncrypted) : null,
        })),
      );

      const checkRows = await db().select().from(schema.conflictChecks);
      tables.conflictChecks = await Promise.all(
        checkRows.map(async ({ queryEncrypted, decisionNotesEncrypted, ...rest }) => ({
          ...rest,
          query: await decryptJson(queryEncrypted),
          decisionNotes: decisionNotesEncrypted ? await decryptJson(decisionNotesEncrypted) : null,
        })),
      );

      const documents = await db().select().from(schema.documents);
      tables.documents = await Promise.all(
        documents.map(async (row) => {
          const {
            encryptedContent: _sealed,
            storageKey: _key,
            contentKeyVersion: _v,
            ...rest
          } = row;
          return { ...rest, content: await decryptJson(await readSealedContent(row)) };
        }),
      );

      await auditService.logEvent(
        {
          entityType: 'firm',
          entityId: firm.id,
          action: 'firm_exported',
          summary: 'Full firm data export produced',
          details: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
        },
        { fullName: `${PLATFORM_LEGAL_NAME} operations`, role: 'system' },
      );

      return {
        format: 'ahava88-firm-export/v1',
        exportedAt: new Date().toISOString(),
        firm,
        tables,
      };
    },
    { system: true },
  );
}
