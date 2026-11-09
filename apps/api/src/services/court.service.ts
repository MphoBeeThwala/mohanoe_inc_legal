// Court details on a matter: the division and the court's case number, which
// court-roll matching uses (normalised by courtCaseKey).
import { eq } from 'drizzle-orm';
import type { MatterCase } from '@ahava88/shared';
import { db } from '../db/client';
import { cases } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { courtCaseKey } from '../lib/court';
import { matterCourtSchema, parse } from '../validation/schemas';
import * as intakeService from './intake.service';
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
  const [saved] = await db()
    .update(cases)
    .set({
      courtDivision: court.courtDivision,
      courtCaseNumber: court.courtCaseNumber,
      courtCaseKey: key,
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
      details: { courtDivision: court.courtDivision, courtCaseNumber: court.courtCaseNumber },
    },
    actor,
  );
  return intakeService.toMatterCase(saved!);
}
