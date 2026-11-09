// Opening clients and matters, and who is on a matter. Every new client and
// matter needs a conflict check that was cleared (or waived by an
// administrator); a client of the firm can't be added as an opposing party
// without a recorded waiver.
import type { MatterCase, MatterParty, PartyRecord } from '@ahava88/shared';
import { db } from '../db/client';
import { withSystemScope } from '../db/tenant';
import { caseMembers, cases } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import {
  clientInputSchema,
  matterOpenSchema,
  matterPartySchema,
  parse,
} from '../validation/schemas';
import { requireClearedCheck, isWaiver } from './conflict.service';
import * as partyService from './party.service';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

export async function createClient(input: unknown, actor: Actor): Promise<PartyRecord> {
  const { conflictCheckId, ...party } = parse(clientInputSchema, input);
  await requireClearedCheck(conflictCheckId);
  const saved = await partyService.createParty(party, actor, { isClient: true, conflictCheckId });
  return partyService.getParty(saved.id);
}

/** Makes an existing party (e.g. a former opposing party) a client. */
export async function convertToClient(partyId: string, conflictCheckId: string, actor: Actor) {
  await requireClearedCheck(conflictCheckId);
  const row = await partyService.requireParty(partyId);
  await partyService.markClient(row.id, conflictCheckId);
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: row.id,
      action: 'client_created',
      summary: `Party ${row.partyNumber} became a client`,
      details: { conflictCheckId },
    },
    actor,
  );
  return partyService.getParty(row.id);
}

export async function openMatter(input: unknown, actor: Actor): Promise<MatterCase> {
  const matter = parse(matterOpenSchema, input);
  await requireClearedCheck(matter.conflictCheckId);
  const client = await partyService.requireParty(matter.clientId);
  if (!client.isClient) {
    throw httpError('Open the client first (after a conflict check)', 409);
  }
  const [saved] = await db()
    .insert(cases)
    .values({
      caseNumber: await intakeService.nextCaseNumber(),
      title: matter.title,
      // The client's reference number, never their name.
      clientLabel: client.partyNumber,
      practiceArea: matter.practiceArea,
      urgency: matter.urgency,
      status: 'open',
      nextAction: 'Plan the matter and record the first steps.',
    })
    .returning();
  if (!saved) {
    throw new Error('Matter was not stored');
  }
  if (actor.userId) {
    await db()
      .insert(caseMembers)
      .values({ caseId: saved.id, userId: actor.userId, memberRole: 'lead', addedBy: actor.userId })
      .onConflictDoNothing();
  }
  await partyService.linkParty(saved.id, client.id, 'client');
  await auditService.logEvent(
    {
      entityType: 'case',
      entityId: saved.id,
      action: 'matter_opened',
      summary: `Matter opened: ${saved.caseNumber}`,
      details: { clientParty: client.partyNumber, conflictCheckId: matter.conflictCheckId },
    },
    actor,
  );
  return intakeService.toMatterCase(saved);
}

async function requireCase(caseRef: string) {
  const caseRecord = await intakeService.findCaseByRef(caseRef);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }
  return caseRecord;
}

export async function addMatterParty(
  caseRef: string,
  input: unknown,
  actor: Actor,
): Promise<MatterParty[]> {
  const request = parse(matterPartySchema, input);
  const caseRecord = await requireCase(caseRef);
  const partyId = request.partyId
    ? (await partyService.requireParty(request.partyId)).id
    : (await partyService.createParty(request.party, actor)).id;

  if (request.role === 'client') {
    const party = await partyService.requireParty(partyId);
    if (!party.isClient) {
      throw httpError('Only a cleared client can be added as a client on a matter', 409);
    }
  } else {
    // Acting against an existing client is a conflict, whatever matter it's on.
    const isClient = await withSystemScope(() => partyService.isFirmClient(partyId));
    if (isClient && !(await isWaiver(request.conflictCheckId))) {
      throw httpError(
        'This party is a client of the firm. Run a conflict check and record a waiver first.',
        409,
      );
    }
  }
  await partyService.linkParty(caseRecord.id, partyId, request.role);
  await auditService.logEvent(
    {
      entityType: 'case',
      entityId: caseRecord.id,
      action: 'matter_party_added',
      summary: `Party added to ${caseRecord.caseNumber} as ${request.role}`,
      details: { partyId, role: request.role, conflictCheckId: request.conflictCheckId ?? null },
    },
    actor,
  );
  return partyService.listMatterParties(caseRecord.id);
}

export async function removeMatterParty(
  caseRef: string,
  partyId: string,
  role: string,
  actor: Actor,
): Promise<MatterParty[]> {
  const caseRecord = await requireCase(caseRef);
  const removed = await partyService.unlinkParty(
    caseRecord.id,
    partyId,
    role as Parameters<typeof partyService.unlinkParty>[2],
  );
  if (!removed) {
    throw httpError('That party is not on this matter in that role', 404);
  }
  await auditService.logEvent(
    {
      entityType: 'case',
      entityId: caseRecord.id,
      action: 'matter_party_removed',
      summary: `Party removed from ${caseRecord.caseNumber}`,
      details: { partyId, role },
    },
    actor,
  );
  return partyService.listMatterParties(caseRecord.id);
}

export async function matterParties(caseRef: string): Promise<MatterParty[]> {
  return partyService.listMatterParties((await requireCase(caseRef)).id);
}
