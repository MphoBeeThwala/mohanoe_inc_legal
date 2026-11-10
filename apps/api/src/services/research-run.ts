// Answering a confirmed research brief (roadmap §7, steps 3-6):
//
// 3. Query planning: the model turns the de-identified brief into short
//    search queries.
// 4. Retrieval from the approved corpus only (corpus.service search): in
//    force, ranked by relevance and the hierarchy of authority.
// 5. Constrained generation: the model may only state what the numbered
//    passages support, citing them as [S1], [S2]...
// 6. Verification in code: a claim that cites nothing, cites a passage that
//    was not retrieved, quotes words that aren't in its sources, or names an
//    authority that wasn't retrieved is removed and listed as removed.
//
// No passages → "no authority found", without asking the model to answer.
import {
  AUTHORITY_LEVELS,
  type CitedSource,
  type ResearchAnswer,
  type ResearchClaim,
} from '@ahava88/shared';
import { parseJsonAnswer } from '../lib/ai-client';
import { callModel } from './ai.service';
import { search, type SearchHit } from './corpus.service';
import type { Actor } from '../lib/actor';

const PLAN_SYSTEM = [
  'You plan searches of a South African legal database for an attorney.',
  'The brief is de-identified: people appear as tokens such as [Client]; never put tokens or guesses about people into queries.',
  'Return one JSON object: {"queries": string[]} with 3 to 6 short keyword queries (2-8 words each).',
  'Name the statutes, rules, legal concepts and remedies likely to be relevant (for example "Prevention of Illegal Eviction Act unlawful occupier", "spoliation order possession").',
].join(' ');

const ANSWER_SYSTEM = [
  'You are a legal research assistant for attorneys at a South African law firm.',
  'Answer the research question in the brief USING ONLY the numbered source passages provided. Do not use any other knowledge.',
  'Every claim must cite at least one passage by its reference, e.g. ["S2"]. Never cite or name a case, statute, rule or article that is not among the passages.',
  'Prefer higher authority (lower level number); note when a source is amended, or is a tribunal decision, firm precedent or commentary rather than binding authority.',
  'If the passages do not answer the question, say so: set noAuthority to true and leave claims empty rather than guessing.',
  'People appear as tokens such as [Client]; keep them as they are.',
  'This is research for an attorney to verify, not advice to a client.',
  'Return one JSON object only: {"claims": [{"text": string, "citations": string[]}], "gaps": string[], "noAuthority": boolean}.',
].join(' ');

export interface ModelAnswer {
  claims?: Array<{ text?: unknown; citations?: unknown }>;
  gaps?: unknown;
  noAuthority?: unknown;
}

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[“”"‘’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Authorities named in the text: neutral citations, law reports, Acts. */
const NAMED_AUTHORITY =
  /\[(?:19|20)\d{2}\]\s+ZA[A-Z]{2,8}\s+\d+|\d{4}\s+\(\d+\)\s+SA\s+\d+\s+\([A-Z]+\)|\bAct\s+\d+\s+of\s+(?:19|20)\d{2}\b/g;

/** Checks each claim against the passages it cites; see the file header. */
export function verifyClaims(
  answer: ModelAnswer,
  sources: CitedSource[],
): { claims: ResearchClaim[]; removed: ResearchAnswer['removed'] } {
  const byRef = new Map(sources.map((source) => [source.ref, source]));
  const known = normalise(sources.map((s) => `${s.citation} ${s.title} ${s.text}`).join(' '));
  const claims: ResearchClaim[] = [];
  const removed: ResearchAnswer['removed'] = [];

  for (const raw of Array.isArray(answer.claims) ? answer.claims : []) {
    const text = String(raw?.text ?? '').trim();
    if (!text) continue;
    const cited = (Array.isArray(raw?.citations) ? raw.citations : [])
      .map((ref) =>
        String(ref)
          .replace(/[[\]\s]/g, '')
          .toUpperCase(),
      )
      .filter(Boolean);
    const valid = [...new Set(cited.filter((ref) => byRef.has(ref)))];
    if (!cited.length) {
      removed.push({ text, reason: 'Cited no source' });
      continue;
    }
    if (!valid.length || valid.length < cited.length) {
      removed.push({ text, reason: 'Cited a source that was not retrieved' });
      continue;
    }
    const citedText = normalise(valid.map((ref) => byRef.get(ref)!.text).join(' '));
    const quotes = [...text.matchAll(/["“]([^"”]{12,})["”]/g)].map((m) => normalise(m[1]!));
    if (quotes.some((quote) => !citedText.includes(quote))) {
      removed.push({ text, reason: 'Quoted words that are not in the cited source' });
      continue;
    }
    const named = text.match(NAMED_AUTHORITY) ?? [];
    if (named.some((authority) => !known.includes(normalise(authority)))) {
      removed.push({ text, reason: 'Named an authority that was not retrieved' });
      continue;
    }
    claims.push({ text, citations: valid });
  }
  return { claims, removed };
}

function sourceBlock(source: CitedSource): string {
  const status =
    source.validity === 'amended'
      ? 'in force, amended'
      : source.validity === 'in_force'
        ? 'in force'
        : source.validity;
  const meta = [
    `level ${source.authorityLevel} (${AUTHORITY_LEVELS[source.authorityLevel] ?? 'other'})`,
    source.kind === 'precedent' ? 'firm precedent (not authority)' : source.sourceName,
    source.court,
    status,
    source.versionDate ? `text as at ${source.versionDate}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return `[${source.ref}] ${source.citation}${source.pinpoint ? `, ${source.pinpoint}` : ''} — ${source.title}\n(${meta})\n${source.text}`;
}

export function toCited(hits: SearchHit[]): CitedSource[] {
  return hits.map(({ key: _key, rank: _rank, ...hit }, index) => ({
    ref: `S${index + 1}`,
    ...hit,
  }));
}

export async function answerBrief(
  brief: string,
  context: { subjectId: string; actor: Actor },
): Promise<Omit<ResearchAnswer, 'claimsNamed'>> {
  const call = {
    subjectType: 'research_request',
    subjectId: context.subjectId,
    actor: context.actor,
  };
  const plan = await callModel(
    {
      model: 'research',
      system: PLAN_SYSTEM,
      messages: [{ role: 'user', content: brief }],
      maxTokens: 400,
      temperature: 0,
    },
    { ...call, purpose: 'research' },
  );
  const queries = (parseJsonAnswer<{ queries?: unknown }>(plan.text).queries ?? []) as unknown[];
  const cleanQueries = (Array.isArray(queries) ? queries : [])
    .map((q) =>
      String(q)
        .replace(/\[[^\]]*\]/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 6);

  const sources = toCited(await search(cleanQueries, 12));
  const generatedAt = new Date().toISOString();
  if (!sources.length) {
    return {
      noAuthority: true,
      claims: [],
      removed: [],
      gaps: ['No passage in the approved sources matched this question.'],
      sources: [],
      queries: cleanQueries,
      model: plan.model,
      generatedAt,
    };
  }

  const result = await callModel(
    {
      model: 'research',
      system: ANSWER_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `${brief}\n\nSource passages:\n\n${sources.map(sourceBlock).join('\n\n')}`,
        },
      ],
      maxTokens: 3000,
      temperature: 0,
    },
    { ...call, purpose: 'research' },
  );
  const answer = parseJsonAnswer<ModelAnswer>(result.text);
  const { claims, removed } = verifyClaims(answer, sources);
  const gaps = (Array.isArray(answer.gaps) ? answer.gaps : [])
    .map(String)
    .filter(Boolean)
    .slice(0, 20);
  return {
    noAuthority: claims.length === 0,
    claims,
    removed,
    gaps,
    // Only what the answer can be checked against.
    sources,
    queries: cleanQueries,
    model: result.model,
    generatedAt,
  };
}
