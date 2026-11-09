// Outgoing email (invites, password resets, invoices).
//
// SMTP_URL configures a real transport (Azure Communication Services Email
// exposes SMTP). Without it, mail is not sent: callers fall back to showing
// the link to the administrator who created it. In tests, sent messages are
// kept in an in-memory outbox. Message bodies are never logged: they carry
// personal information.
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

/** Sends a message. Returns false when no transport is configured. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  if (process.env.NODE_ENV === 'test') {
    outbox.push(message);
    return true;
  }
  const transport = getTransporter();
  if (!transport) {
    return false;
  }
  await transport.sendMail({
    from: process.env.MAIL_FROM || 'no-reply@localhost',
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
