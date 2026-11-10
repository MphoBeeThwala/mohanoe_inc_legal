import { expect, test } from 'vitest';
import type { CitedSource } from '@ahava88/shared';
import { scoreCase, summarise } from '../eval/score';

const source = (ref: string, citation: string) => ({ ref, citation }) as CitedSource;

test('evaluation scoring: cited authorities, required and forbidden phrases, no-authority cases', () => {
  const answer = {
    noAuthority: false,
    claims: [{ text: 'A court order is required before a lockout.', citations: ['S1'] }],
    removed: [{ text: 'x', reason: 'Cited no source' }],
    sources: [source('S1', 'Act 901 of 2099'), source('S2', 'Act 902 of 2099')],
  };
  const good = scoreCase(
    {
      id: 'a',
      practiceArea: '',
      brief: '',
      expect: { mustCite: [['Act 901 of 2099']], mustSay: ['court'] },
    },
    answer,
  );
  expect(good).toMatchObject({ passed: true, citedRecall: 1, removed: 1 });

  const bad = scoreCase(
    {
      id: 'b',
      practiceArea: '',
      brief: '',
      expect: { mustCite: [['Act 902 of 2099']], mustNotSay: ['lockout'], noAuthority: true },
    },
    answer,
  );
  expect(bad.failures).toEqual([
    'Expected "no authority found"',
    'Did not cite Act 902 of 2099',
    'Said /lockout/',
  ]);
  expect(summarise([good, bad], 'm')).toMatchObject({
    cases: 2,
    passed: 1,
    passRate: 0.5,
    removedRate: 0.5,
  });
});
