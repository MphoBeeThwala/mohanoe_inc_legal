// Support desk and help centre.
//
// Firm side (tenant context): staff raise requests and read replies; an
// administrator sees every request the firm has raised. Platform side (the
// console): operators read and answer requests across firms.
//
// Subjects and messages are encrypted with the firm's key. Emails never carry
// them: only the request number and a link. Audit rows carry the number only.
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ConsoleTicket,
  ConsoleTicketSummary,
  HelpArticle,
  HelpCentre,
  SupportTicket,
  SupportTicketMessage,
  SupportTicketSummary,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '@ahava88/shared';
import { hasPermission } from '@ahava88/shared';
import { db, rootDb } from '../db/client';
import { atomically, withTenant } from '../db/tenant';
import { currentFirm } from '../db/tenant-context';
import { nextValue } from '../db/sequences';
import {
  firms,
  helpArticles,
  supportTicketMessages,
  supportTickets,
  users,
  type FirmRow,
  type PlatformOperatorRow,
  type SupportTicketRow,
} from '../db/schema';
import type { Actor } from '../lib/actor';
import { httpError } from '../lib/http';
import { isUuid } from '../lib/ids';
import { iso, isoOrNull } from '../lib/time';
import { parse } from '../validation/schemas';
import * as auditService from './audit.service';
import { firmOrigin } from './firm.service';
import { sendMail } from './mail.service';
import { decryptJson, encryptJson } from './privacy.service';
import { consoleHost, record, requireAdmin } from './platform-console.service';

const CATEGORIES = ['question', 'problem', 'billing', 'data_request', 'security'] as const;
const STATUSES = ['open', 'answered', 'closed'] as const;

const body = z.string().trim().min(1).max(10_000);
const newTicketSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body,
  category: z.enum(CATEGORIES),
  priority: z.enum(['normal', 'urgent']).default('normal'),
});
const replySchema = z.object({ body });

const supportEmail = () => String(process.env.PLATFORM_SUPPORT_EMAIL || '').trim() || null;
const statusPageUrl = () => {
  const url = String(process.env.PLATFORM_STATUS_URL || '').trim();
  return /^https:\/\//.test(url) ? url : null;
};

// ------------------------------------------------------------ help centre

export async function helpCentre(): Promise<HelpCentre> {
  const rows = await db()
    .select({ slug: helpArticles.slug, title: helpArticles.title, category: helpArticles.category })
    .from(helpArticles)
    .where(eq(helpArticles.published, true))
    .orderBy(asc(helpArticles.sortOrder), asc(helpArticles.title));
  return { articles: rows, statusPageUrl: statusPageUrl(), supportEmail: supportEmail() };
}

const toArticle = (row: typeof helpArticles.$inferSelect): HelpArticle => ({
  slug: row.slug,
  title: row.title,
  category: row.category,
  body: row.body,
  published: row.published,
  sortOrder: row.sortOrder,
  updatedAt: iso(row.updatedAt),
});

export async function article(slug: string): Promise<HelpArticle> {
  const [row] = await db()
    .select()
    .from(helpArticles)
    .where(and(eq(helpArticles.slug, slug), eq(helpArticles.published, true)));
  if (!row) throw httpError('Article not found', 404);
  return toArticle(row);
}

// ------------------------------------------------------------ firm side

async function names(ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const rows = await db()
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((row) => [row.id, row.fullName]));
}

async function summary(
  row: SupportTicketRow,
  people: Map<string, string>,
): Promise<SupportTicketSummary> {
  return {
    id: row.id,
    number: row.number,
    subject: (await decryptJson<string>(row.subjectEncrypted)) ?? '',
    category: row.category as TicketCategory,
    priority: row.priority as TicketPriority,
    status: row.status as TicketStatus,
    createdAt: iso(row.createdAt),
    lastMessageAt: iso(row.lastMessageAt),
    createdBy: row.createdBy ? (people.get(row.createdBy) ?? null) : null,
  };
}

async function messagesOf(ticketId: string): Promise<SupportTicketMessage[]> {
  const rows = await db()
    .select()
    .from(supportTicketMessages)
    .where(eq(supportTicketMessages.ticketId, ticketId))
    .orderBy(asc(supportTicketMessages.createdAt));
  const people = await names(rows.map((row) => row.userId));
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      author: row.author as 'staff' | 'operator',
      name:
        row.author === 'operator'
          ? `${row.operatorName || 'Support'} (support)`
          : (row.userId && people.get(row.userId)) || 'Former staff member',
      body: (await decryptJson<string>(row.bodyEncrypted)) ?? '',
      createdAt: iso(row.createdAt),
    })),
  );
}

const seesAll = (actor: Actor) => hasPermission(actor.role ?? undefined, 'helpdesk.manage');

async function visibleTicket(id: string, actor: Actor): Promise<SupportTicketRow> {
  if (!isUuid(id)) throw httpError('Request not found', 404);
  const [row] = await db().select().from(supportTickets).where(eq(supportTickets.id, id));
  // Staff see their own requests; administrators see all of the firm's.
  if (!row || (!seesAll(actor) && row.createdBy !== actor.userId)) {
    throw httpError('Request not found', 404);
  }
  return row;
}

export async function listTickets(actor: Actor): Promise<SupportTicketSummary[]> {
  const rows = await db()
    .select()
    .from(supportTickets)
    .where(seesAll(actor) ? undefined : eq(supportTickets.createdBy, actor.userId ?? ''))
    .orderBy(desc(supportTickets.lastMessageAt))
    .limit(200);
  const people = await names(rows.map((row) => row.createdBy));
  return Promise.all(rows.map((row) => summary(row, people)));
}

export async function getTicket(id: string, actor: Actor): Promise<SupportTicket> {
  const row = await visibleTicket(id, actor);
  const people = await names([row.createdBy]);
  return { ...(await summary(row, people)), messages: await messagesOf(row.id) };
}

/** Tells the platform's support mailbox: number, firm and urgency only. */
async function notifyPlatform(firm: FirmRow, row: SupportTicketRow, what: string) {
  const to = supportEmail();
  if (!to) return;
  const host = consoleHost();
  await sendMail({
    platform: true,
    to,
    subject: `${row.priority === 'urgent' ? '[Urgent] ' : ''}${what}: ${firm.slug} ${row.number}`,
    text: [
      `${what} from ${firm.slug} (${row.number}, ${row.category}).`,
      '',
      host ? `https://${host}/console#ticket-${firm.id}-${row.id}` : 'Open the platform console.',
    ].join('\n'),
  });
}

async function audit(row: SupportTicketRow, action: string, summaryText: string, actor: Actor) {
  await auditService.logEvent(
    {
      entityType: 'support_ticket',
      entityId: row.id,
      action,
      summary: summaryText,
      details: { number: row.number, category: row.category, priority: row.priority },
    },
    actor,
  );
}

export async function createTicket(input: unknown, actor: Actor): Promise<SupportTicket> {
  const values = parse(newTicketSchema, input);
  const row = await atomically(async () => {
    const number = `SUP-${String(await nextValue('support_ticket')).padStart(6, '0')}`;
    const [ticket] = await db()
      .insert(supportTickets)
      .values({
        number,
        createdBy: actor.userId ?? null,
        category: values.category,
        priority: values.priority,
        subjectEncrypted: await encryptJson(values.subject),
      })
      .returning();
    await db()
      .insert(supportTicketMessages)
      .values({
        ticketId: ticket!.id,
        author: 'staff',
        userId: actor.userId ?? null,
        bodyEncrypted: await encryptJson(values.body),
      });
    await audit(ticket!, 'support_ticket_raised', `Support request ${number} raised`, actor);
    return ticket!;
  });
  await notifyPlatform(currentFirm(), row, 'New support request');
  return getTicket(row.id, actor);
}

export async function replyAsStaff(
  id: string,
  input: unknown,
  actor: Actor,
): Promise<SupportTicket> {
  const { body: text } = parse(replySchema, input);
  const row = await visibleTicket(id, actor);
  const now = new Date();
  await atomically(async () => {
    await db()
      .insert(supportTicketMessages)
      .values({
        ticketId: row.id,
        author: 'staff',
        userId: actor.userId ?? null,
        bodyEncrypted: await encryptJson(text),
      });
    // Replying reopens a closed request.
    await db()
      .update(supportTickets)
      .set({ status: 'open', closedAt: null, lastMessageAt: now })
      .where(eq(supportTickets.id, row.id));
    await audit(row, 'support_ticket_reply', `Replied on support request ${row.number}`, actor);
  });
  await notifyPlatform(currentFirm(), row, 'Reply on support request');
  return getTicket(row.id, actor);
}

export async function closeTicket(id: string, actor: Actor): Promise<SupportTicket> {
  const row = await visibleTicket(id, actor);
  if (row.status !== 'closed') {
    const now = new Date();
    await db()
      .update(supportTickets)
      .set({ status: 'closed', closedAt: now })
      .where(eq(supportTickets.id, row.id));
    await audit(row, 'support_ticket_closed', `Support request ${row.number} closed`, actor);
  }
  return getTicket(row.id, actor);
}

// ------------------------------------------------------------ console side

async function allFirms(): Promise<FirmRow[]> {
  return rootDb().select().from(firms).orderBy(asc(firms.slug));
}

async function firmById(firmId: string): Promise<FirmRow> {
  if (!isUuid(firmId)) throw httpError('Firm not found', 404);
  const [firm] = await rootDb().select().from(firms).where(eq(firms.id, firmId));
  if (!firm) throw httpError('Firm not found', 404);
  return firm;
}

async function consoleSummary(
  firm: FirmRow,
  row: SupportTicketRow,
  people: Map<string, string>,
): Promise<ConsoleTicketSummary> {
  return {
    ...(await summary(row, people)),
    firmId: firm.id,
    firmSlug: firm.slug,
    firstResponseAt: isoOrNull(row.firstResponseAt),
  };
}

/** Requests across firms: open and answered by default, urgent first. */
export async function consoleTickets(status?: string): Promise<ConsoleTicketSummary[]> {
  const wanted = STATUSES.includes(status as TicketStatus) ? (status as TicketStatus) : null;
  const out: ConsoleTicketSummary[] = [];
  for (const firm of await allFirms()) {
    out.push(
      ...(await withTenant(
        firm,
        async () => {
          const rows = await db()
            .select()
            .from(supportTickets)
            .where(wanted ? eq(supportTickets.status, wanted) : ne(supportTickets.status, 'closed'))
            .orderBy(desc(supportTickets.lastMessageAt))
            .limit(200);
          const people = await names(rows.map((row) => row.createdBy));
          return Promise.all(rows.map((row) => consoleSummary(firm, row, people)));
        },
        { system: true },
      )),
    );
  }
  return out.sort(
    (a, b) =>
      Number(b.priority === 'urgent') - Number(a.priority === 'urgent') ||
      Number(a.status !== 'open') - Number(b.status !== 'open') ||
      a.lastMessageAt.localeCompare(b.lastMessageAt),
  );
}

async function consoleRow(id: string): Promise<SupportTicketRow> {
  if (!isUuid(id)) throw httpError('Request not found', 404);
  const [row] = await db().select().from(supportTickets).where(eq(supportTickets.id, id));
  if (!row) throw httpError('Request not found', 404);
  return row;
}

export async function consoleTicket(firmId: string, id: string): Promise<ConsoleTicket> {
  const firm = await firmById(firmId);
  return withTenant(
    firm,
    async () => {
      const row = await consoleRow(id);
      const people = await names([row.createdBy]);
      return {
        ...(await consoleSummary(firm, row, people)),
        messages: await messagesOf(row.id),
      };
    },
    { system: true },
  );
}

/** Any operator may answer (answering is not a platform setting). */
export async function operatorReply(
  operator: PlatformOperatorRow,
  firmId: string,
  id: string,
  input: unknown,
): Promise<ConsoleTicket> {
  const { body: text } = parse(replySchema, input);
  const firm = await firmById(firmId);
  const row = await withTenant(
    firm,
    async () => {
      const ticket = await consoleRow(id);
      const now = new Date();
      await atomically(async () => {
        await db()
          .insert(supportTicketMessages)
          .values({
            ticketId: ticket.id,
            author: 'operator',
            operatorId: operator.id,
            operatorName: operator.fullName,
            bodyEncrypted: await encryptJson(text),
          });
        await db()
          .update(supportTickets)
          .set({
            status: 'answered',
            closedAt: null,
            lastMessageAt: now,
            firstResponseAt: ticket.firstResponseAt ?? now,
          })
          .where(eq(supportTickets.id, ticket.id));
        await audit(ticket, 'support_ticket_answered', `Support replied on ${ticket.number}`, {
          fullName: `${operator.fullName} (platform support)`,
          role: 'system',
        });
      });
      // Tell whoever raised it; the reply itself stays in the app.
      if (ticket.createdBy) {
        const [staff] = await db()
          .select({ email: users.email, fullName: users.fullName, isActive: users.isActive })
          .from(users)
          .where(eq(users.id, ticket.createdBy));
        if (staff?.isActive) {
          await sendMail({
            platform: true,
            to: staff.email,
            subject: `Support replied on ${ticket.number}`,
            text: [
              `Hello ${staff.fullName},`,
              '',
              `Support has replied to your request ${ticket.number}. Read it under Help in your workspace:`,
              '',
              `${firmOrigin(firm)}/#section-help`,
            ].join('\n'),
          });
        }
      }
      return ticket;
    },
    { system: true },
  );
  await record(operator, 'ticket_answered', firm.id, `Replied on ${firm.slug} ${row.number}`);
  return consoleTicket(firm.id, row.id);
}

export async function setConsoleStatus(
  operator: PlatformOperatorRow,
  firmId: string,
  id: string,
  input: unknown,
): Promise<ConsoleTicket> {
  const { status } = parse(z.object({ status: z.enum(STATUSES) }), input);
  const firm = await firmById(firmId);
  const row = await withTenant(
    firm,
    async () => {
      const ticket = await consoleRow(id);
      const now = new Date();
      await db()
        .update(supportTickets)
        .set({ status, closedAt: status === 'closed' ? now : null })
        .where(eq(supportTickets.id, ticket.id));
      return ticket;
    },
    { system: true },
  );
  await record(operator, 'ticket_status', firm.id, `${firm.slug} ${row.number}: ${status}`);
  return consoleTicket(firm.id, row.id);
}

// Help articles: platform content, changed only by console administrators.

const articleSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,79}$/, 'lower-case letters, digits and dashes'),
  title: z.string().trim().min(3).max(200),
  category: z.string().trim().min(2).max(80),
  body: z.string().trim().min(1).max(50_000),
  published: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(10_000).default(0),
});

export async function consoleArticles(): Promise<HelpArticle[]> {
  const rows = await rootDb()
    .select()
    .from(helpArticles)
    .orderBy(asc(helpArticles.sortOrder), asc(helpArticles.title));
  return rows.map(toArticle);
}

export async function saveArticle(
  operator: PlatformOperatorRow,
  input: unknown,
): Promise<HelpArticle> {
  requireAdmin(operator);
  const values = parse(articleSchema, input);
  const [row] = await rootDb()
    .insert(helpArticles)
    .values(values)
    .onConflictDoUpdate({
      target: helpArticles.slug,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  await record(
    operator,
    'help_article_saved',
    null,
    `Help article ${values.slug}${values.published ? '' : ' (unpublished)'}`,
  );
  return toArticle(row!);
}

export async function deleteArticle(operator: PlatformOperatorRow, slug: string): Promise<void> {
  requireAdmin(operator);
  const [row] = await rootDb()
    .delete(helpArticles)
    .where(eq(helpArticles.slug, slug))
    .returning({ slug: helpArticles.slug });
  if (!row) throw httpError('Article not found', 404);
  await record(operator, 'help_article_deleted', null, `Help article ${slug} deleted`);
}
