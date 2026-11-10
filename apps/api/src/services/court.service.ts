// Court details on a matter: the division and the court's case number, which
// court-roll matching uses (normalised by courtCaseKey).
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  COURT_DIVISIONS,
  type CourtOnlineCourt,
  type CourtOnlineStatus,
  type CourtRollWatchers,
  type MatterCase,
} from '@ahava88/shared';
import { db, rootDb } from '../db/client';
import { currentFirm } from '../db/tenant-context';
import { cases, courtOnlineCourts, firms, users } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { courtCaseKey } from '../lib/court';
import { matterCourtSchema, parse } from '../validation/schemas';
import * as intakeService from './intake.service';
import { clearFirmCache } from './firm.service';
import * as auditService from './audit.service';

export async function setMatterCourt(
  caseRef: string,
  input: unknown,
  actor: Actor = {},
): Promise<MatterCase> {
  const court = parse(matterCourtSchema, input);
  const matter = await intakeService.findCaseByRef(caseRef);
  if (!matter) {
    throw httpError('Case not found', 404);
  }
  const key = courtCaseKey(court.courtCaseNumber);
  if (court.courtCaseNumber && !key) {
    throw httpError(
      'That is not a court case number we can match (e.g. 12345/2025 or 2025-012345)',
      400,
    );
  }
  const onlineKey = courtCaseKey(court.courtOnlineReference ?? null);
  if (court.courtOnlineReference && !onlineKey) {
    throw httpError('That is not a Court Online case number we can match (e.g. 2025-012345)', 400);
  }
  const [saved] = await db()
    .update(cases)
    .set({
      courtDivision: court.courtDivision,
      courtCaseNumber: court.courtCaseNumber,
      courtCaseKey: key,
      ...(court.courtOnlineReference !== undefined
        ? { courtOnlineReference: court.courtOnlineReference, courtOnlineKey: onlineKey }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(cases.id, matter.id))
    .returning();
  await auditService.logEvent(
    {
      entityType: 'case',
      entityId: matter.id,
      action: 'matter_court_set',
      summary: `Court details set on ${matter.caseNumber}`,
      details: {
        courtDivision: court.courtDivision,
        courtCaseNumber: court.courtCaseNumber,
        courtOnlineReference: court.courtOnlineReference ?? null,
      },
    },
    actor,
  );
  return intakeService.toMatterCase(saved!);
}

/** The Court Online portal (configurable; the judiciary's page by default). */
export const courtOnlineUrl = () =>
  process.env.COURT_ONLINE_URL || 'https://www.judiciary.org.za/index.php/court-online';

/** Whether the matter's court uses Court Online. */
export async function courtOnlineFor(caseRef: string): Promise<CourtOnlineStatus> {
  const matter = await intakeService.findCaseByRef(caseRef);
  if (!matter) {
    throw httpError('Case not found', 404);
  }
  const [court] = matter.courtDivision
    ? await db()
        .select()
        .from(courtOnlineCourts)
        .where(eq(courtOnlineCourts.division, matter.courtDivision))
    : [];
  return {
    court: court ? { division: court.division, since: court.since, source: court.source } : null,
    url: courtOnlineUrl(),
  };
}

export async function listCourtOnlineCourts(): Promise<CourtOnlineCourt[]> {
  const rows = await db().select().from(courtOnlineCourts).orderBy(courtOnlineCourts.division);
  return rows.map(({ division, since, source }) => ({ division, since, source }));
}

/** Platform administration (ops CLI). */
export async function setCourtOnlineCourt(division: string, since: string, source: string) {
  if (!COURT_DIVISIONS.some((court) => court.code === division)) {
    throw httpError(`Unknown division ${division}`, 400);
  }
  if (!since.trim() || !source.trim()) throw httpError('Give --since and --source', 400);
  await rootDb()
    .insert(courtOnlineCourts)
    .values({ division, since: since.trim(), source: source.trim() })
    .onConflictDoUpdate({
      target: courtOnlineCourts.division,
      set: { since: since.trim(), source: source.trim(), updatedAt: new Date() },
    });
}

export async function removeCourtOnlineCourt(division: string): Promise<boolean> {
  const rows = await rootDb()
    .delete(courtOnlineCourts)
    .where(eq(courtOnlineCourts.division, division))
    .returning({ division: courtOnlineCourts.division });
  return rows.length > 0;
}

const watchersSchema = z.object({ userIds: z.array(z.string().uuid()).max(50) });

/** Staff who also get every court roll notice (firm administrators choose). */
export async function rollWatchers(): Promise<CourtRollWatchers> {
  return { userIds: currentFirm().notificationSettings?.courtRollWatcherIds ?? [] };
}

export async function setRollWatchers(input: unknown, actor: Actor): Promise<CourtRollWatchers> {
  const { userIds } = parse(watchersSchema, input);
  const unique = [...new Set(userIds)];
  const valid = unique.length
    ? await db()
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, unique), eq(users.isActive, true), ne(users.role, 'support')))
    : [];
  if (valid.length !== unique.length) {
    throw httpError('Choose active staff members', 400);
  }
  const firm = currentFirm();
  await db()
    .update(firms)
    .set({ notificationSettings: { ...firm.notificationSettings, courtRollWatcherIds: unique } })
    .where(eq(firms.id, firm.id));
  clearFirmCache();
  await auditService.logEvent(
    {
      entityType: 'firm',
      entityId: firm.id,
      action: 'court_roll_watchers_set',
      summary: `Court roll notices also go to ${unique.length} staff member(s)`,
      details: { userIds: unique },
    },
    actor,
  );
  return { userIds: unique };
}
