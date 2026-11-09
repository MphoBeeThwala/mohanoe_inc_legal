// Matter-level access and ethical walls.
//
// The rules are enforced by PostgreSQL (app_case_visible() and the
// *_matter_access RLS policies in migration 0002); this service only manages
// the data they read:
//   - cases.access 'firm' (default): every staff member whose role can see
//     matters; 'restricted': only the matter's members, plus administrators.
//   - case_exclusions (ethical walls): the user never sees the matter, whatever
//     their role, admins included.
// Admins and the matter's leads manage access. A user who creates a matter
// (by assessing an intake) becomes its lead.
import { and, asc, eq } from 'drizzle-orm';
import type { MatterAccess, MatterExclusion, MatterMember, UserRole } from '@ahava88/shared';
import { db } from '../db/client';
import { caseExclusions, caseMembers, cases, users, type CaseRow } from '../db/schema';
import { httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { iso } from '../lib/time';
import {
  matterAccessSchema,
  matterExclusionSchema,
  matterMemberSchema,
  parse,
  uuidSchema,
} from '../validation/schemas';
import * as intakeService from './intake.service';
import * as auditService from './audit.service';

async function requireCase(caseRef: string): Promise<CaseRow> {
  const caseRecord = await intakeService.findCaseByRef(caseRef);
  if (!caseRecord) {
    throw httpError('Case not found', 404);
  }
  return caseRecord;
}

async function isLead(caseId: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId) {
    return false;
  }
  const [row] = await db()
    .select({ memberRole: caseMembers.memberRole })
    .from(caseMembers)
    .where(and(eq(caseMembers.caseId, caseId), eq(caseMembers.userId, userId)))
    .limit(1);
  return row?.memberRole === 'lead';
}

async function canManage(caseRecord: CaseRow, actor: Actor): Promise<boolean> {
  return actor.role === 'admin' || isLead(caseRecord.id, actor.userId);
}

async function requireManage(caseRef: string, actor: Actor): Promise<CaseRow> {
  const caseRecord = await requireCase(caseRef);
  if (!(await canManage(caseRecord, actor))) {
    throw httpError('Only an administrator or the matter lead can change access', 403);
  }
  return caseRecord;
}

async function requireStaff(userId: string) {
  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.id, parse(uuidSchema, userId)))
    .limit(1);
  if (!user || !user.isActive) {
    throw httpError('Staff member not found', 404);
  }
  return user;
}

export async function getAccess(caseRef: string, actor: Actor): Promise<MatterAccess> {
  const caseRecord = await requireCase(caseRef);
  const [members, exclusions] = await Promise.all([
    db()
      .select({ member: caseMembers, user: users })
      .from(caseMembers)
      .innerJoin(users, eq(users.id, caseMembers.userId))
      .where(eq(caseMembers.caseId, caseRecord.id))
      .orderBy(asc(users.fullName)),
    db()
      .select({ exclusion: caseExclusions, user: users })
      .from(caseExclusions)
      .innerJoin(users, eq(users.id, caseExclusions.userId))
      .where(eq(caseExclusions.caseId, caseRecord.id))
      .orderBy(asc(users.fullName)),
  ]);
  const manage = await canManage(caseRecord, actor);
  return {
    caseId: caseRecord.id,
    access: caseRecord.access as MatterAccess['access'],
    members: members.map(({ member, user }): MatterMember => ({
      userId: user.id,
      fullName: user.fullName,
      role: user.role as UserRole,
      memberRole: member.memberRole as MatterMember['memberRole'],
      addedAt: iso(member.createdAt),
    })),
    // Wall reasons are for the people who manage access.
    exclusions: exclusions.map(({ exclusion, user }): MatterExclusion => ({
      userId: user.id,
      fullName: user.fullName,
      role: user.role as UserRole,
      reason: manage ? exclusion.reason : '',
      createdAt: iso(exclusion.createdAt),
    })),
    canManage: manage,
  };
}

export async function setAccess(caseRef: string, input: unknown, actor: Actor) {
  const { access } = parse(matterAccessSchema, input);
  const caseRecord = await requireManage(caseRef, actor);
  if (access === 'restricted' && actor.userId && actor.role !== 'admin') {
    // A lead restricting a matter stays on it.
    await addMemberRow(caseRecord.id, actor.userId, 'lead', actor.userId);
  }
  await db()
    .update(cases)
    .set({ access, updatedAt: new Date() })
    .where(eq(cases.id, caseRecord.id));
  await auditService.logEventSafely(
    {
      entityType: 'case',
      entityId: caseRecord.id,
      action: 'matter_access_changed',
      summary: `Matter access set to ${access}: ${caseRecord.caseNumber}`,
      details: { from: caseRecord.access, to: access },
    },
    actor,
  );
  return getAccess(caseRecord.id, actor);
}

async function addMemberRow(
  caseId: string,
  userId: string,
  memberRole: string,
  addedBy?: string | null,
) {
  await db()
    .insert(caseMembers)
    .values({ caseId, userId, memberRole, addedBy: addedBy ?? null })
    .onConflictDoUpdate({
      target: [caseMembers.caseId, caseMembers.userId],
      set: { memberRole },
    });
}

/** Called when a user creates a matter: they lead it. */
export async function addCreatorAsLead(caseId: string, userId: string | null | undefined) {
  if (userId) {
    await addMemberRow(caseId, userId, 'lead', userId);
  }
}

export async function addMember(caseRef: string, input: unknown, actor: Actor) {
  const { userId, memberRole } = parse(matterMemberSchema, input);
  const caseRecord = await requireManage(caseRef, actor);
  const user = await requireStaff(userId);
  const [walled] = await db()
    .select({ id: caseExclusions.id })
    .from(caseExclusions)
    .where(and(eq(caseExclusions.caseId, caseRecord.id), eq(caseExclusions.userId, user.id)))
    .limit(1);
  if (walled) {
    throw httpError(
      'This person is behind an ethical wall for this matter. Remove the wall first.',
      409,
    );
  }
  await addMemberRow(caseRecord.id, user.id, memberRole, actor.userId);
  await auditService.logEventSafely(
    {
      entityType: 'case',
      entityId: caseRecord.id,
      action: 'matter_member_added',
      summary: `Member added to ${caseRecord.caseNumber}`,
      details: { userId: user.id, memberRole },
    },
    actor,
  );
  return getAccess(caseRecord.id, actor);
}

export async function removeMember(caseRef: string, userId: string, actor: Actor) {
  const caseRecord = await requireManage(caseRef, actor);
  const removed = await db()
    .delete(caseMembers)
    .where(
      and(eq(caseMembers.caseId, caseRecord.id), eq(caseMembers.userId, parse(uuidSchema, userId))),
    )
    .returning({ id: caseMembers.id });
  if (!removed.length) {
    throw httpError('Not a member of this matter', 404);
  }
  await auditService.logEventSafely(
    {
      entityType: 'case',
      entityId: caseRecord.id,
      action: 'matter_member_removed',
      summary: `Member removed from ${caseRecord.caseNumber}`,
      details: { userId },
    },
    actor,
  );
  // The actor may have removed their own access to a restricted matter.
  const visible = await intakeService.findCaseByRef(caseRecord.id);
  return visible ? getAccess(caseRecord.id, actor) : null;
}

export async function addExclusion(caseRef: string, input: unknown, actor: Actor) {
  const { userId, reason } = parse(matterExclusionSchema, input);
  const caseRecord = await requireManage(caseRef, actor);
  if (userId === actor.userId) {
    throw httpError('You cannot put yourself behind an ethical wall', 400);
  }
  const user = await requireStaff(userId);
  await db()
    .delete(caseMembers)
    .where(and(eq(caseMembers.caseId, caseRecord.id), eq(caseMembers.userId, user.id)));
  await db()
    .insert(caseExclusions)
    .values({ caseId: caseRecord.id, userId: user.id, reason, createdBy: actor.userId ?? null })
    .onConflictDoUpdate({
      target: [caseExclusions.caseId, caseExclusions.userId],
      set: { reason },
    });
  await auditService.logEventSafely(
    {
      entityType: 'case',
      entityId: caseRecord.id,
      // The reason may name people: it is not copied into the audit trail.
      action: 'ethical_wall_added',
      summary: `Ethical wall added on ${caseRecord.caseNumber}`,
      details: { userId: user.id },
    },
    actor,
  );
  return getAccess(caseRecord.id, actor);
}

export async function removeExclusion(caseRef: string, userId: string, actor: Actor) {
  const caseRecord = await requireManage(caseRef, actor);
  const removed = await db()
    .delete(caseExclusions)
    .where(
      and(
        eq(caseExclusions.caseId, caseRecord.id),
        eq(caseExclusions.userId, parse(uuidSchema, userId)),
      ),
    )
    .returning({ id: caseExclusions.id });
  if (!removed.length) {
    throw httpError('No ethical wall for this person on this matter', 404);
  }
  await auditService.logEventSafely(
    {
      entityType: 'case',
      entityId: caseRecord.id,
      action: 'ethical_wall_removed',
      summary: `Ethical wall removed on ${caseRecord.caseNumber}`,
      details: { userId },
    },
    actor,
  );
  return getAccess(caseRecord.id, actor);
}
