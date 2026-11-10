// The client portal: clients see their own matters, never a staff screen.
//
// Identity: staff (portal.manage) invite a client party; the emailed link
// lets the client set up an authenticator. Signing in later takes an emailed
// one-time link AND an authenticator code (two factors). Portal sessions are
// server-side (hashed tokens, separate cookie, idle and absolute expiry).
//
// Scope: every portal query is limited to clientCaseIds(): the matters where
// the portal user's party is linked as the client. Those queries run with
// matter restrictions lifted (a client sees their own restricted matter),
// so nothing here may read a matter outside that list.
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  PortalAccess,
  PortalDocument,
  PortalEnrolment,
  PortalInvoice,
  PortalMatter,
  PortalMe,
  PortalMessage,
} from '@ahava88/shared';
import { db } from '../db/client';
import { withSystemScope } from '../db/tenant';
import { currentFirm } from '../db/tenant-context';
import {
  caseParties,
  cases,
  documents,
  invoices,
  parties,
  portalLinks,
  portalMessages,
  portalSessions,
  portalUsers,
  trustEntries,
  users,
  type PortalUserRow,
} from '../db/schema';
import { authSettings } from '../config/auth';
import { clearCookie, readCookie, setCookie } from '../lib/cookies';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import type { Actor } from '../lib/actor';
import { generateSecret, otpauthUrl, verifyCode } from '../lib/totp';
import { randomToken, sha256 } from '../lib/tokens';
import { iso, isoOrNull } from '../lib/time';
import { parse } from '../validation/schemas';
import { blindIndex, blindIndexCandidates, decryptJson, encryptJson } from './privacy.service';
import { partyDetails } from './party.service';
import { firmOrigin } from './firm.service';
import { sendMail } from './mail.service';
import { readSealedContent } from './documents.service';
import * as fica from './fica.service';
import * as auditService from './audit.service';
import QRCode from 'qrcode';
import { getFirmBrand } from '../config/brand';

const INVITE_HOURS = 72;
const SIGN_IN_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;
const IDLE_MINUTES = 30;
const MAX_HOURS = 12;

const cookieName = () => (authSettings().secureCookies ? '__Host-portal' : 'portal');
const normaliseEmail = (value: string) => value.trim().toLowerCase();
const firmName = () => {
  const firm = currentFirm();
  return firm.tradingName || firm.legalName;
};

/** Portal actions in audit rows: the client, by party number. */
async function clientActor(user: PortalUserRow): Promise<Actor> {
  const [party] = await db()
    .select({ number: parties.partyNumber })
    .from(parties)
    .where(eq(parties.id, user.partyId));
  return { fullName: `Client ${party?.number ?? ''} (portal)`.replace('  ', ' ') };
}

// ------------------------------------------------------------- staff side

async function requireClientParty(partyId: string) {
  if (!isUuid(partyId)) throw httpError('Client not found', 404);
  const [party] = await db().select().from(parties).where(eq(parties.id, partyId));
  if (!party) throw httpError('Client not found', 404);
  if (!party.isClient) throw httpError('Only clients can be given portal access', 409);
  return party;
}

function toAccess(row: PortalUserRow, partyNumber: string): PortalAccess {
  return {
    id: row.id,
    partyNumber,
    status: row.status as PortalAccess['status'],
    invitedAt: iso(row.createdAt),
    lastSignInAt: isoOrNull(row.lastSignInAt),
  };
}

export async function accessFor(partyId: string): Promise<PortalAccess | null> {
  const party = await requireClientParty(partyId);
  const [row] = await db().select().from(portalUsers).where(eq(portalUsers.partyId, party.id));
  return row ? toAccess(row, party.partyNumber) : null;
}

async function newLink(user: PortalUserRow, purpose: 'invite' | 'sign_in', minutes: number) {
  const token = randomToken();
  await db()
    .insert(portalLinks)
    .values({
      portalUserId: user.id,
      purpose,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + minutes * 60_000),
    });
  return token;
}

const inviteSchema = z.object({ email: z.string().trim().email().max(254).optional() });

/** Invites (or re-invites, resetting the authenticator) a client to the portal. */
export async function invite(partyId: string, input: unknown, actor: Actor): Promise<PortalAccess> {
  const party = await requireClientParty(partyId);
  const { email: override } = parse(inviteSchema, input ?? {});
  const details = await partyDetails(party);
  const email = normaliseEmail(override || details.email || '');
  if (!email) throw httpError('Add the client’s email address first (or give one)', 400);

  const values = {
    emailIndex: await blindIndex(email),
    emailEncrypted: await encryptJson(email),
    status: 'invited',
    totpSecretEncrypted: null,
    lastTotpStep: null,
    invitedBy: actor.userId ?? null,
    updatedAt: new Date(),
  };
  const [existing] = await db().select().from(portalUsers).where(eq(portalUsers.partyId, party.id));
  const [user] = existing
    ? await db().update(portalUsers).set(values).where(eq(portalUsers.id, existing.id)).returning()
    : await db()
        .insert(portalUsers)
        .values({ partyId: party.id, ...values })
        .returning()
        .catch(() => {
          throw httpError('Another client already uses that email for the portal', 409);
        });
  // A new invite ends old links and sessions.
  await db().delete(portalLinks).where(eq(portalLinks.portalUserId, user!.id));
  await db()
    .update(portalSessions)
    .set({ revokedAt: new Date() })
    .where(eq(portalSessions.portalUserId, user!.id));

  const token = await newLink(user!, 'invite', INVITE_HOURS * 60);
  const link = `${firmOrigin(currentFirm())}/portal?invite=${token}`;
  await sendMail({
    to: email,
    subject: `${firmName()}: your client portal`,
    text: [
      `Hello ${details.name},`,
      '',
      `${firmName()} has given you access to its secure client portal, where you can follow your matters, read documents shared with you, see invoices and send messages.`,
      '',
      `Set up your access (the link works for ${INVITE_HOURS} hours):`,
      link,
      '',
      'You will need an authenticator app on your phone (for example Microsoft Authenticator or Google Authenticator).',
    ].join('\n'),
  });
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: party.id,
      action: 'portal_invited',
      summary: `Portal access sent to client ${party.partyNumber}`,
      details: { portalUserId: user!.id },
    },
    actor,
  );
  return toAccess(user!, party.partyNumber);
}

export async function disable(portalUserId: string, actor: Actor): Promise<PortalAccess> {
  if (!isUuid(portalUserId)) throw httpError('Portal access not found', 404);
  const [user] = await db()
    .update(portalUsers)
    .set({ status: 'disabled', updatedAt: new Date() })
    .where(eq(portalUsers.id, portalUserId))
    .returning();
  if (!user) throw httpError('Portal access not found', 404);
  await db()
    .update(portalSessions)
    .set({ revokedAt: new Date() })
    .where(eq(portalSessions.portalUserId, user.id));
  await db().delete(portalLinks).where(eq(portalLinks.portalUserId, user.id));
  const [party] = await db()
    .select({ number: parties.partyNumber })
    .from(parties)
    .where(eq(parties.id, user.partyId));
  await auditService.logEvent(
    {
      entityType: 'party',
      entityId: user.partyId,
      action: 'portal_disabled',
      summary: `Portal access withdrawn for client ${party?.number ?? ''}`,
      details: { portalUserId: user.id },
    },
    actor,
  );
  return toAccess(user, party?.number ?? '');
}

// ------------------------------------------------------- client sign-in

async function consumeLink(token: string, purpose: 'invite' | 'sign_in') {
  const [link] = await db()
    .select({ link: portalLinks, user: portalUsers })
    .from(portalLinks)
    .innerJoin(portalUsers, eq(portalUsers.id, portalLinks.portalUserId))
    .where(
      and(
        eq(portalLinks.tokenHash, sha256(String(token ?? ''))),
        eq(portalLinks.purpose, purpose),
        isNull(portalLinks.usedAt),
        gt(portalLinks.expiresAt, new Date()),
      ),
    );
  if (!link || link.link.attempts >= MAX_CODE_ATTEMPTS || link.user.status === 'disabled') {
    throw httpError('This link has expired or was already used. Ask for a new one.', 400);
  }
  return link;
}

async function checkCode(
  link: { link: typeof portalLinks.$inferSelect; user: PortalUserRow },
  secret: string,
  code: string,
) {
  const step = verifyCode(secret, String(code ?? ''));
  if (step === null || (link.user.lastTotpStep !== null && step <= link.user.lastTotpStep)) {
    await db()
      .update(portalLinks)
      .set({ attempts: link.link.attempts + 1 })
      .where(eq(portalLinks.id, link.link.id));
    throw httpError('That code is not right. Check the authenticator app and try again.', 401);
  }
  return step;
}

async function startSession(user: PortalUserRow, res: Response) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + MAX_HOURS * 3_600_000);
  await db()
    .insert(portalSessions)
    .values({ portalUserId: user.id, tokenHash: sha256(token), expiresAt });
  setCookie(res, cookieName(), token, {
    secure: authSettings().secureCookies,
    sameSite: 'Lax',
    maxAgeSeconds: MAX_HOURS * 3600,
  });
  await db()
    .update(portalUsers)
    .set({ lastSignInAt: new Date() })
    .where(eq(portalUsers.id, user.id));
}

/** Invite link, step 1: an authenticator secret to scan (shown once per invite). */
export async function beginEnrolment(token: string): Promise<PortalEnrolment> {
  const { user } = await consumeLink(token, 'invite');
  const secret = generateSecret();
  await db()
    .update(portalUsers)
    .set({
      totpSecretEncrypted: await encryptJson(secret),
      lastTotpStep: null,
      updatedAt: new Date(),
    })
    .where(eq(portalUsers.id, user.id));
  const [party] = await db().select().from(parties).where(eq(parties.id, user.partyId));
  const details = party ? await partyDetails(party) : null;
  const email = (await decryptJson<string>(user.emailEncrypted)) ?? '';
  const url = otpauthUrl(secret, email, getFirmBrand(currentFirm()).productName);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
  return {
    secret,
    otpauthUrl: url,
    qrCodeDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    name: details?.name ?? '',
  };
}

const codeSchema = z.object({
  token: z.string().min(10).max(200),
  code: z.string().trim().min(6).max(8),
});

/** Invite link, step 2: the first code proves the authenticator works; signs in. */
export async function completeEnrolment(input: unknown, res: Response): Promise<PortalMe> {
  const { token, code } = parse(codeSchema, input);
  const link = await consumeLink(token, 'invite');
  const secret = link.user.totpSecretEncrypted
    ? await decryptJson<string>(link.user.totpSecretEncrypted)
    : null;
  if (!secret) throw httpError('Open the invite link again to set up the authenticator', 400);
  const step = await checkCode(link, secret, code);
  await db()
    .update(portalLinks)
    .set({ usedAt: new Date() })
    .where(eq(portalLinks.id, link.link.id));
  const [user] = await db()
    .update(portalUsers)
    .set({ status: 'active', lastTotpStep: step, updatedAt: new Date() })
    .where(eq(portalUsers.id, link.user.id))
    .returning();
  await startSession(user!, res);
  await auditService.logEventSafely(
    {
      entityType: 'party',
      entityId: user!.partyId,
      action: 'portal_activated',
      summary: 'Client portal access set up',
      details: {},
    },
    await clientActor(user!),
  );
  return me(user!);
}

/** Emails a sign-in link if the address belongs to an active client; the answer never says. */
export async function requestSignIn(input: unknown): Promise<void> {
  const { email } = parse(z.object({ email: z.string().trim().email().max(254) }), input);
  const candidates = await blindIndexCandidates(normaliseEmail(email));
  const [user] = await db()
    .select()
    .from(portalUsers)
    .where(and(inArray(portalUsers.emailIndex, candidates), eq(portalUsers.status, 'active')));
  if (!user) return;
  const token = await newLink(user, 'sign_in', SIGN_IN_MINUTES);
  await sendMail({
    to: normaliseEmail(email),
    subject: `${firmName()}: sign in to your client portal`,
    text: [
      `Use this link to sign in (it works once, for ${SIGN_IN_MINUTES} minutes). You will also need the code from your authenticator app.`,
      '',
      `${firmOrigin(currentFirm())}/portal?signin=${token}`,
      '',
      'If you did not ask to sign in, ignore this email.',
    ].join('\n'),
  });
}

/** The emailed link plus an authenticator code: both factors, then a session. */
export async function completeSignIn(input: unknown, res: Response): Promise<PortalMe> {
  const { token, code } = parse(codeSchema, input);
  const link = await consumeLink(token, 'sign_in');
  if (link.user.status !== 'active' || !link.user.totpSecretEncrypted) {
    throw httpError('This link has expired or was already used. Ask for a new one.', 400);
  }
  const secret = (await decryptJson<string>(link.user.totpSecretEncrypted))!;
  const step = await checkCode(link, secret, code);
  await db()
    .update(portalLinks)
    .set({ usedAt: new Date() })
    .where(eq(portalLinks.id, link.link.id));
  await db()
    .update(portalUsers)
    .set({ lastTotpStep: step })
    .where(eq(portalUsers.id, link.user.id));
  await startSession(link.user, res);
  return me(link.user);
}

/** The signed-in portal user for this request, or a 401. */
export async function requirePortalUser(req: Request): Promise<PortalUserRow> {
  const token = readCookie(req, cookieName());
  if (!token) throw httpError('Please sign in', 401);
  const now = new Date();
  const [row] = await db()
    .select({ session: portalSessions, user: portalUsers })
    .from(portalSessions)
    .innerJoin(portalUsers, eq(portalUsers.id, portalSessions.portalUserId))
    .where(
      and(
        eq(portalSessions.tokenHash, sha256(token)),
        isNull(portalSessions.revokedAt),
        gt(portalSessions.expiresAt, now),
      ),
    );
  if (!row || row.user.status !== 'active') throw httpError('Please sign in', 401);
  if (now.getTime() - row.session.lastSeenAt.getTime() > IDLE_MINUTES * 60_000) {
    await db()
      .update(portalSessions)
      .set({ revokedAt: now })
      .where(eq(portalSessions.id, row.session.id));
    throw httpError('Your session timed out. Please sign in again.', 401);
  }
  await db()
    .update(portalSessions)
    .set({ lastSeenAt: now })
    .where(eq(portalSessions.id, row.session.id));
  return row.user;
}

export async function signOut(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, cookieName());
  if (token) {
    await db()
      .update(portalSessions)
      .set({ revokedAt: new Date() })
      .where(eq(portalSessions.tokenHash, sha256(token)));
  }
  clearCookie(res, cookieName(), { secure: authSettings().secureCookies, sameSite: 'Lax' });
}

// ---------------------------------------------------------- client data

/** The only matters a portal user may see: where their party is the client. */
async function clientCaseIds(user: PortalUserRow): Promise<string[]> {
  const rows = await db()
    .select({ caseId: caseParties.caseId })
    .from(caseParties)
    .where(and(eq(caseParties.partyId, user.partyId), eq(caseParties.role, 'client')));
  return [...new Set(rows.map((row) => row.caseId))];
}

/** Runs a client-data read with matter restrictions lifted, given the client's matters. */
function asClient<T>(user: PortalUserRow, fn: (caseIds: string[]) => Promise<T>): Promise<T> {
  return withSystemScope(async () => fn(await clientCaseIds(user)));
}

export async function me(user: PortalUserRow): Promise<PortalMe> {
  const [party] = await db().select().from(parties).where(eq(parties.id, user.partyId));
  return { name: party ? (await partyDetails(party)).name : '', firmName: firmName() };
}

export function matters(user: PortalUserRow): Promise<PortalMatter[]> {
  return asClient(user, async (ids) => {
    if (!ids.length) return [];
    const rows = await db()
      .select()
      .from(cases)
      .where(inArray(cases.id, ids))
      .orderBy(desc(cases.createdAt));
    const trustOn = Boolean(currentFirm().features?.trustAccounting);
    return Promise.all(
      rows.map(async (row) => {
        const [trust] = trustOn
          ? await db()
              .select({ total: sql<string>`coalesce(sum(${trustEntries.amountCents}), 0)` })
              .from(trustEntries)
              .where(and(eq(trustEntries.caseId, row.id), eq(trustEntries.status, 'posted')))
          : [];
        const [unread] = await db()
          .select({ count: sql<number>`count(*)::int` })
          .from(portalMessages)
          .where(
            and(
              eq(portalMessages.caseId, row.id),
              eq(portalMessages.sender, 'staff'),
              isNull(portalMessages.readByClientAt),
            ),
          );
        return {
          id: row.id,
          caseNumber: row.caseNumber,
          title: row.title ?? row.practiceArea,
          status: row.status,
          update: row.clientUpdateEncrypted
            ? ((await decryptJson<string>(row.clientUpdateEncrypted)) ?? null)
            : null,
          updatedAt: isoOrNull(row.clientUpdateAt),
          trustBalanceCents: trustOn ? Number(trust?.total ?? 0) : null,
          unreadMessages: unread?.count ?? 0,
        };
      }),
    );
  });
}

export function sharedDocuments(user: PortalUserRow): Promise<PortalDocument[]> {
  return asClient(user, async (ids) => {
    if (!ids.length) return [];
    const rows = await db()
      .select()
      .from(documents)
      .where(and(inArray(documents.caseId, ids), isNotNull(documents.sharedWithClientAt)))
      .orderBy(desc(documents.sharedWithClientAt));
    return rows.map((row) => ({
      id: row.id,
      caseNumber: row.caseNumber,
      title: row.title,
      documentType: row.documentType,
      sharedAt: iso(row.sharedWithClientAt!),
    }));
  });
}

export function sharedDocument(user: PortalUserRow, documentId: string) {
  return asClient(user, async (ids) => {
    if (!isUuid(documentId) || !ids.length) throw httpError('Document not found', 404);
    const [row] = await db()
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          inArray(documents.caseId, ids),
          isNotNull(documents.sharedWithClientAt),
        ),
      );
    if (!row) throw httpError('Document not found', 404);
    const content = await decryptJson<{ title: string; body: string }>(
      await readSealedContent(row),
    );
    await auditService.logEventSafely(
      {
        entityType: 'document',
        entityId: row.id,
        action: 'portal_document_viewed',
        summary: `Client viewed a shared document on ${row.caseNumber}`,
        details: {},
      },
      await clientActor(user),
    );
    return {
      id: row.id,
      caseNumber: row.caseNumber,
      title: content?.title ?? row.title,
      body: content?.body ?? '',
    };
  });
}

export function clientInvoices(user: PortalUserRow): Promise<PortalInvoice[]> {
  return asClient(user, async (ids) => {
    if (!ids.length) return [];
    const rows = await db()
      .select({ invoice: invoices, caseNumber: cases.caseNumber })
      .from(invoices)
      .innerJoin(cases, eq(cases.id, invoices.caseId))
      .where(
        and(
          inArray(invoices.caseId, ids),
          inArray(invoices.status, ['issued', 'partially_paid', 'paid']),
        ),
      )
      .orderBy(desc(invoices.issuedAt));
    return rows.map(({ invoice, caseNumber }) => ({
      id: invoice.id,
      caseNumber,
      invoiceNumber: invoice.invoiceNumber ?? '',
      issuedOn: invoice.issuedAt ? iso(invoice.issuedAt).slice(0, 10) : null,
      dueOn: invoice.dueAt ? iso(invoice.dueAt).slice(0, 10) : null,
      totalCents: invoice.totalCents,
      paidCents: invoice.paidCents,
      status: invoice.status,
    }));
  });
}

async function requireClientCase(user: PortalUserRow, caseId: string, ids: string[]) {
  if (!isUuid(caseId) || !ids.includes(caseId)) throw httpError('Matter not found', 404);
  const [row] = await db().select().from(cases).where(eq(cases.id, caseId));
  if (!row) throw httpError('Matter not found', 404);
  return row;
}

async function presentMessages(caseId: string, caseNumber: string): Promise<PortalMessage[]> {
  const rows = await db()
    .select({ message: portalMessages, staffName: users.fullName })
    .from(portalMessages)
    .leftJoin(users, eq(users.id, portalMessages.staffUserId))
    .where(eq(portalMessages.caseId, caseId))
    .orderBy(asc(portalMessages.createdAt));
  return Promise.all(
    rows.map(async ({ message, staffName }) => ({
      id: message.id,
      caseNumber,
      from: message.sender as PortalMessage['from'],
      senderName: message.sender === 'staff' ? (staffName ?? firmName()) : 'You',
      body: (await decryptJson<string>(message.bodyEncrypted)) ?? '',
      sentAt: iso(message.createdAt),
    })),
  );
}

export function clientMessages(user: PortalUserRow, caseId: string): Promise<PortalMessage[]> {
  return asClient(user, async (ids) => {
    const matter = await requireClientCase(user, caseId, ids);
    await db()
      .update(portalMessages)
      .set({ readByClientAt: new Date() })
      .where(
        and(
          eq(portalMessages.caseId, matter.id),
          eq(portalMessages.sender, 'staff'),
          isNull(portalMessages.readByClientAt),
        ),
      );
    return presentMessages(matter.id, matter.caseNumber);
  });
}

const messageSchema = z.object({ body: z.string().trim().min(1, 'Write a message').max(5000) });

export function sendClientMessage(
  user: PortalUserRow,
  caseId: string,
  input: unknown,
): Promise<PortalMessage[]> {
  return asClient(user, async (ids) => {
    const { body } = parse(messageSchema, input);
    const matter = await requireClientCase(user, caseId, ids);
    await db()
      .insert(portalMessages)
      .values({
        caseId: matter.id,
        sender: 'client',
        portalUserId: user.id,
        bodyEncrypted: await encryptJson(body),
      });
    await auditService.logEventSafely(
      {
        entityType: 'matter',
        entityId: matter.id,
        action: 'portal_message_from_client',
        summary: `Client message on ${matter.caseNumber}`,
        details: {},
      },
      await clientActor(user),
    );
    return presentMessages(matter.id, matter.caseNumber);
  });
}

/** The client's FICA status, and what is still needed. */
export async function clientFica(user: PortalUserRow) {
  const profile = await fica.getProfile(user.partyId);
  return {
    status: profile.status,
    missing: profile.missing,
    uploaded: profile.documents.map((d) => ({ docType: d.docType, uploadedAt: d.createdAt })),
  };
}

/** A FICA document from the client (a fee earner still verifies). */
export async function uploadFica(user: PortalUserRow, input: unknown) {
  await fica.uploadDocument(user.partyId, input, await clientActor(user));
  return clientFica(user);
}

// --------------------------------------------- staff: sharing and messages

export async function shareDocument(documentId: string, shared: boolean, actor: Actor) {
  if (!isUuid(documentId)) throw httpError('Document not found', 404);
  const [row] = await db()
    .update(documents)
    .set({ sharedWithClientAt: shared ? new Date() : null })
    .where(eq(documents.id, documentId))
    .returning({ id: documents.id, caseNumber: documents.caseNumber });
  if (!row) throw httpError('Document not found', 404);
  await auditService.logEvent(
    {
      entityType: 'document',
      entityId: row.id,
      action: shared ? 'document_shared_with_client' : 'document_unshared',
      summary: `Document ${shared ? 'shared with' : 'withdrawn from'} the client on ${row.caseNumber}`,
      details: {},
    },
    actor,
  );
  return { id: row.id, shared };
}

export async function setClientUpdate(caseId: string, input: unknown, actor: Actor) {
  const { update } = parse(z.object({ update: z.string().trim().max(2000) }), input);
  if (!isUuid(caseId)) throw httpError('Matter not found', 404);
  const [row] = await db()
    .update(cases)
    .set({
      clientUpdateEncrypted: update ? await encryptJson(update) : null,
      clientUpdateAt: update ? new Date() : null,
    })
    .where(eq(cases.id, caseId))
    .returning({ id: cases.id, caseNumber: cases.caseNumber });
  if (!row) throw httpError('Matter not found', 404);
  await auditService.logEvent(
    {
      entityType: 'matter',
      entityId: row.id,
      action: 'client_update_set',
      summary: `Client update on ${row.caseNumber}`,
      details: {},
    },
    actor,
  );
  return { update: update || null };
}

export async function staffMessages(caseId: string): Promise<PortalMessage[]> {
  if (!isUuid(caseId)) throw httpError('Matter not found', 404);
  const [matter] = await db().select().from(cases).where(eq(cases.id, caseId));
  if (!matter) throw httpError('Matter not found', 404);
  await db()
    .update(portalMessages)
    .set({ readByStaffAt: new Date() })
    .where(
      and(
        eq(portalMessages.caseId, matter.id),
        eq(portalMessages.sender, 'client'),
        isNull(portalMessages.readByStaffAt),
      ),
    );
  return (await presentMessages(matter.id, matter.caseNumber)).map((m) =>
    m.from === 'client' ? { ...m, senderName: 'Client' } : m,
  );
}

/** A staff reply: the client gets an email that says only that there is a message. */
export async function sendStaffMessage(
  caseId: string,
  input: unknown,
  actor: Actor,
): Promise<PortalMessage[]> {
  const { body } = parse(messageSchema, input);
  if (!isUuid(caseId)) throw httpError('Matter not found', 404);
  const [matter] = await db().select().from(cases).where(eq(cases.id, caseId));
  if (!matter) throw httpError('Matter not found', 404);
  await db()
    .insert(portalMessages)
    .values({
      caseId: matter.id,
      sender: 'staff',
      staffUserId: actor.userId ?? null,
      bodyEncrypted: await encryptJson(body),
    });
  const clients = await db()
    .select({ user: portalUsers })
    .from(caseParties)
    .innerJoin(portalUsers, eq(portalUsers.partyId, caseParties.partyId))
    .where(
      and(
        eq(caseParties.caseId, matter.id),
        eq(caseParties.role, 'client'),
        eq(portalUsers.status, 'active'),
      ),
    );
  for (const { user } of clients) {
    const email = await decryptJson<string>(user.emailEncrypted);
    if (email) {
      await sendMail({
        to: email,
        subject: `${firmName()}: a new message on ${matter.caseNumber}`,
        text: `There is a new message for you in the client portal.\n\n${firmOrigin(currentFirm())}/portal`,
      });
    }
  }
  await auditService.logEvent(
    {
      entityType: 'matter',
      entityId: matter.id,
      action: 'portal_message_to_client',
      summary: `Message to the client on ${matter.caseNumber}`,
      details: {},
    },
    actor,
  );
  return staffMessages(matter.id);
}
