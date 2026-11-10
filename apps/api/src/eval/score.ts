// Scoring for the research evaluation set (roadmap §7 controls): run before
// any model or prompt change. Each case is a de-identified brief with what a
// correct answer must (and must not) do.
import type { ResearchAnswer } from '@ahava88/shared';

export interface EvalCase {
  id: string;
  practiceArea: string;
  brief: string;
  expect: {
    /** Citations a good answer relies on (any one of each inner list). */
    mustCite?: string[][];
    /** Phrases (regular expressions) a claim must make. */
    mustSay?: string[];
    /** Phrases no claim may make. */
    mustNotSay?: string[];
    /** The approved sources don't answer this: expect "no authority found". */
    noAuthority?: boolean;
  };
}

export interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  claims: number;
  removed: number;
  citedRecall: number;
}

type Answer = Pick<ResearchAnswer, 'noAuthority' | 'claims' | 'removed' | 'sources'>;

export function scoreCase(testCase: EvalCase, answer: Answer): CaseResult {
  const failures: string[] = [];
  const text = answer.claims.map((claim) => claim.text).join('\n');
  const citedCitations = new Set(
    answer.claims.flatMap((claim) =>
      claim.citations.map((ref) => answer.sources.find((s) => s.ref === ref)?.citation ?? ''),
    ),
  );
  const expectations = testCase.expect;

  if (expectations.noAuthority) {
    if (!answer.noAuthority) failures.push('Expected "no authority found"');
  } else if (answer.noAuthority) {
    failures.push('Answered "no authority found"');
  }
  const groups = expectations.mustCite ?? [];
  const hit = groups.filter((group) => group.some((citation) => citedCitations.has(citation)));
  for (const group of groups) {
    if (!hit.includes(group)) failures.push(`Did not cite ${group.join(' or ')}`);
  }
  for (const pattern of expectations.mustSay ?? []) {
    if (!new RegExp(pattern, 'i').test(text)) failures.push(`Did not say /${pattern}/`);
  }
  for (const pattern of expectations.mustNotSay ?? []) {
    if (new RegExp(pattern, 'i').test(text)) failures.push(`Said /${pattern}/`);
  }
  return {
    id: testCase.id,
    passed: failures.length === 0,
    failures,
    claims: answer.claims.length,
    removed: answer.removed.length,
    citedRecall: groups.length ? hit.length / groups.length : 1,
  };
}

export interface EvalReport {
  model: string | null;
  cases: number;
  passed: number;
  passRate: number;
  /** Share of the model's claims that verification had to remove. */
  removedRate: number;
  meanCitedRecall: number;
  results: CaseResult[];
}

export function summarise(results: CaseResult[], model: string | null): EvalReport {
  const claims = results.reduce((n, r) => n + r.claims + r.removed, 0);
  const removed = results.reduce((n, r) => n + r.removed, 0);
  const passed = results.filter((r) => r.passed).length;
  return {
    model,
    cases: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    removedRate: claims ? removed / claims : 0,
    meanCitedRecall: results.length
      ? results.reduce((n, r) => n + r.citedRecall, 0) / results.length
      : 0,
    results,
  };
}
