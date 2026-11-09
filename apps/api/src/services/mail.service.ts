// Outgoing email (invites, password resets, invoices).
//
// SMTP_URL configures a real transport (Azure Communication Services Email
// exposes SMTP). Without it, mail is not sent: callers fall back to showing
// the link to the administrator who created it. In tests, sent messages are
// kept in an in-memory outbox. Message bodies are never logged: they carry
// personal information.
import { currentTenant } from '../db/tenant-context';
import type { FirmRow } from '../db/schema';
import nodemailer, { type Transporter } from 'nodemailer';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
  /** Set when sent (the test outbox records them). */
  from?: string;
  replyTo?: string;
}

const outbox: MailMessage[] = [];
let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter === undefined) {
    const url = (process.env.SMTP_URL || '').trim();
    transporter = url ? nodemailer.createTransport(url) : null;
  }
  return transporter;
}

export function mailEnabled(): boolean {
  return process.env.NODE_ENV === 'test' ? true : getTransporter() !== null;
}

/**
 * Mail goes out from the platform's address (MAIL_FROM), in the firm's name,
 * with replies to the firm's own address when it has set one.
 */
export function senderFor(firm: FirmRow | undefined): { from: string; replyTo?: string } {
  const address = (process.env.MAIL_FROM || 'no-reply@localhost').replace(/^.*<([^>]+)>.*$/, '$1');
  if (!firm) {
    return { from: process.env.MAIL_FROM || address };
  }
  const name = (firm.tradingName || firm.legalName).replace(/["\\\r\n<>]/g, '').slice(0, 80);
  const replyTo = firm.profile?.replyToEmail || undefined;
  return { from: `"${name}" <${address}>`, ...(replyTo ? { replyTo } : {}) };
}

/** Sends a message. Returns false when no transport is configured. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  if (process.env.NODE_ENV === 'test') {
    outbox.push({ ...message, ...senderFor(currentTenant()?.firm) });
    return true;
  }
  const transport = getTransporter();
  if (!transport) {
    return false;
  }
  await transport.sendMail({
    ...senderFor(currentTenant()?.firm),
    to: message.to,
    subject: message.subject,
    text: message.text,
    attachments: message.attachments,
  });
  return true;
}

/** Test helper: messages "sent" so far. */
export function testOutbox(): MailMessage[] {
  return outbox;
}
