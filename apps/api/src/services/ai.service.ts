// Every model call goes through callModel(): it enforces the firm's monthly
// allowance, records the call (tokens, encrypted de-identified prompt and
// answer) and lets failures through as errors (roadmap §7: no silent
// fallback). Intake triage is built on it.
import { and, eq, gte, sql } from 'drizzle-orm';
import type { AiUsage } from '@ahava88/shared';
import { db } from '../db/client';
import { aiCalls } from '../db/schema';
import {
  aiClient,
  aiConfigured,
  parseJsonAnswer,
  type AiRequest,
  type AiResult,
} from '../lib/ai-client';
import { HttpError, httpError } from '../lib/http';
import type { Actor } from '../lib/actor';
import { encryptJson } from './privacy.service';
import { deidentify, type KnownPerson } from './deidentify';

export type AiPurpose = 'triage' | 'research' | 'evaluation';

export interface CallContext {
  purpose: AiPurpose;
  subjectType?: string;
  subjectId?: string;
  actor?: Actor;
}

/** Tokens a firm may use per calendar month (South African time). */
export function monthlyTokenLimit(): number {
  const value = Number(process.env.AI_FIRM_MONTHLY_TOKENS);
  return Number.isFinite(value) && value > 0 ? value : 2_000_000;
}

function monthStart(now = new Date()): Date {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  return new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), 1) - 2 * 3_600_000);
}

async function tokensThisMonth(now = new Date()): Promise<number> {
  const [row] = await db()
    .select({
      tokens: sql<number>`coalesce(sum(${aiCalls.inputTokens} + ${aiCalls.outputTokens}), 0)::int`,
    })
    .from(aiCalls)
    .where(gte(aiCalls.createdAt, monthStart(now)));
  return row?.tokens ?? 0;
}

export async function callModel(request: AiRequest, context: CallContext): Promise<AiResult> {
  const client = aiClient();
  if ((await tokensThisMonth()) >= monthlyTokenLimit()) {
    throw httpError(
      "This firm's AI allowance for the month is used up. An administrator can ask platform support to raise it.",
      429,
    );
  }
  const started = Date.now();
  const base = {
    purpose: context.purpose,
    subjectType: context.subjectType ?? null,
    subjectId: context.subjectId ?? null,
    provider: client.provider,
    userId: context.actor?.userId ?? null,
    promptEncrypted: await encryptJson({ system: request.system, messages: request.messages }),
  };
  try {
    const result = await client.complete(request);
    await db()
      .insert(aiCalls)
      .values({
        ...base,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        status: 'ok',
        durationMs: Date.now() - started,
        responseEncrypted: await encryptJson({ text: result.text, stopReason: result.stopReason }),
      });
    return result;
  } catch (error) {
    await db()
      .insert(aiCalls)
      .values({
        ...base,
        model: request.model ?? 'default',
        status: 'failed',
        error: error instanceof HttpError ? error.message : 'Unexpected failure',
        durationMs: Date.now() - started,
      });
    throw error;
  }
}

export async function usage(now = new Date()): Promise<AiUsage> {
  const since = monthStart(now);
  const rows = await db()
    .select({
      purpose: aiCalls.purpose,
      calls: sql<number>`count(*)::int`,
      failures: sql<number>`count(*) filter (where ${aiCalls.status} = 'failed')::int`,
      tokens: sql<number>`coalesce(sum(${aiCalls.inputTokens} + ${aiCalls.outputTokens}), 0)::int`,
    })
    .from(aiCalls)
    .where(and(gte(aiCalls.createdAt, since)))
    .groupBy(aiCalls.purpose);
  const sast = new Date(since.getTime() + 2 * 3_600_000);
  return {
    month: sast.toISOString().slice(0, 7),
    tokensUsed: rows.reduce((sum, row) => sum + row.tokens, 0),
    tokenLimit: monthlyTokenLimit(),
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    failures: rows.reduce((sum, row) => sum + row.failures, 0),
    byPurpose: rows.map(({ purpose, calls, tokens }) => ({ purpose, calls, tokens })),
    configured: aiConfigured(),
  };
}

// ------------------------------------------------------------------ triage

/** The intake facts triage works from (raw; de-identified before sending). */
export interface TriageInput {
  practiceArea: string;
  jurisdiction: string;
  urgencyHint: string;
  matterSummary: string;
  requestedOutcome?: string;
  documentsMentioned?: string;
  people: KnownPerson[];
}

export interface AiAssessment {
  provider: string;
  model: string;
  matterType: string;
  urgency: string;
  summary: string;
  keyFacts: string[];
  attorneyQuestions: string[];
  recommendedDocuments: string[];
  complianceFlags: string[];
  nextActions: string[];
  confidence: number;
  popiaNotes: string[];
}

const URGENCIES = ['critical', 'high', 'medium', 'low'];

export function ensureStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item) => item != null && item !== '').map(String);
  }
  if (value == null || value === '') {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .filter((item) => item != null && item !== '')
      .map(String);
  }
  return [String(value)];
}

/** The text triage sends: every field de-identified together. */
export function triageBrief(input: TriageInput) {
  const sections = [
    `Practice area: ${input.practiceArea || 'Not stated'}`,
    `Jurisdiction: ${input.jurisdiction || 'South Africa'}`,
    `Urgency given by the client: ${input.urgencyHint || 'unspecified'}`,
    `Facts:\n${input.matterSummary}`,
    input.requestedOutcome ? `Outcome the client wants:\n${input.requestedOutcome}` : '',
    input.documentsMentioned ? `Documents mentioned:\n${input.documentsMentioned}` : '',
  ].filter(Boolean);
  return deidentify(sections.join('\n\n'), input.people);
}

const TRIAGE_SYSTEM = [
  'You help attorneys at a South African law firm triage new client intakes.',
  'You receive a de-identified intake: people appear as tokens such as [Client]; keep the tokens as they are and do not guess who anyone is.',
  'This is triage for the attorney, not legal advice and not a legal opinion: do not state what the law is or cite authority.',
  'Point out facts that suggest deadlines (prescription, court dates, notice periods) so the attorney checks them.',
  'Answer with one JSON object and nothing else, with keys:',
  'matterType (string), urgency ("critical" | "high" | "medium" | "low"), summary (string, at most 120 words),',
  'keyFacts (string[]), attorneyQuestions (string[]), recommendedDocuments (string[]),',
  'complianceFlags (string[]), nextActions (string[]), confidence (number 0-1).',
].join(' ');

/** No model configured: an honest "not assessed" record, never invented advice. */
function notAssessed(input: TriageInput): AiAssessment {
  const hint = input.urgencyHint.toLowerCase();
  return {
    provider: 'none',
    model: 'none',
    matterType: input.practiceArea || 'General',
    urgency: URGENCIES.includes(hint) ? hint : 'medium',
    summary:
      'Not assessed by AI (AI is not configured for this platform). An attorney must review the intake.',
    keyFacts: [],
    attorneyQuestions: [],
    recommendedDocuments: [],
    complianceFlags: [],
    nextActions: ['Attorney to review the intake and confirm next steps.'],
    confidence: 0,
    popiaNotes: ['No information was sent to an AI service.'],
  };
}

export interface TriageOutcome {
  assessment: AiAssessment;
  /** What was sent (or would have been), for the assessment record. */
  brief: { text: string; replacements: Array<{ token: string; kind: string; count: number }> };
}

/**
 * Triage an intake. With AI configured, a failed or malformed answer is an
 * error the user sees (and can retry); without it, the matter is opened as
 * "not assessed".
 */
export async function triage(
  input: TriageInput,
  context: Omit<CallContext, 'purpose'>,
): Promise<TriageOutcome> {
  const brief = triageBrief(input);
  const sent = { text: brief.text, replacements: brief.replacements };
  if (!aiConfigured()) {
    return { assessment: notAssessed(input), brief: sent };
  }
  const result = await callModel(
    {
      system: TRIAGE_SYSTEM,
      messages: [{ role: 'user', content: brief.text }],
      maxTokens: 1500,
      temperature: 0,
    },
    { ...context, purpose: 'triage' },
  );
  const parsed = parseJsonAnswer<Record<string, unknown>>(result.text);
  const urgency = String(parsed.urgency ?? '').toLowerCase();
  const confidence = Number(parsed.confidence);
  return {
    assessment: {
      provider: result.provider,
      model: result.model,
      matterType: String(parsed.matterType || input.practiceArea || 'General').slice(0, 100),
      urgency: URGENCIES.includes(urgency) ? urgency : 'medium',
      summary: String(parsed.summary ?? '').slice(0, 2000),
      keyFacts: ensureStringArray(parsed.keyFacts),
      attorneyQuestions: ensureStringArray(parsed.attorneyQuestions),
      recommendedDocuments: ensureStringArray(parsed.recommendedDocuments),
      complianceFlags: ensureStringArray(parsed.complianceFlags),
      nextActions: ensureStringArray(parsed.nextActions),
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      popiaNotes: [
        `Only a de-identified brief was sent (${brief.replacements.reduce((n, r) => n + r.count, 0)} identifiers removed).`,
      ],
    },
    brief: sent,
  };
}
