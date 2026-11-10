// The research evaluation set: every case in eval/cases against the corpus
// snapshot in eval/corpus, with the configured model. Writes
// eval/report.json and fails below EVAL_MIN_PASS_RATE (default 0.9) or above
// EVAL_MAX_REMOVED_RATE (default 0.2).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { aiConfigured } from '../lib/ai-client';
import { importDocument, upsertSource, type DocumentInput } from '../services/corpus.service';
import { answerBrief } from '../services/research-run';
import { inDefaultFirm } from '../test/helpers';
import { scoreCase, summarise, type CaseResult, type EvalCase } from './score';

const root = path.resolve(__dirname, '../../eval');

async function readJson<T>(dir: string): Promise<T[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(path.join(dir, file), 'utf8')) as T),
  );
}

interface CorpusFile {
  source: { code: string; name: string; kind: string; licence: string };
  documents: DocumentInput[];
}

test('research evaluation set', async () => {
  if (!aiConfigured()) {
    throw new Error(
      'Set AI_PROVIDER, AI_MODEL (and AI_ENDPOINT / AI_API_KEY) to run the evaluation.',
    );
  }
  for (const corpus of await readJson<CorpusFile>(path.join(root, 'corpus'))) {
    await upsertSource({ ...corpus.source, approvedBy: 'evaluation' });
    for (const document of corpus.documents) {
      await importDocument(corpus.source.code, document);
    }
  }
  const cases = await readJson<EvalCase>(path.join(root, 'cases'));
  const results: CaseResult[] = [];
  let model: string | null = null;
  for (const testCase of cases) {
    const answer = await inDefaultFirm(() =>
      answerBrief(testCase.brief, { subjectId: '00000000-0000-4000-8000-000000000000', actor: {} }),
    );
    model = answer.model;
    results.push(scoreCase(testCase, answer));
  }
  const report = summarise(results, model);
  await writeFile(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Evaluation: ${report.passed}/${report.cases} passed, removed-claim rate ${(report.removedRate * 100).toFixed(1)}%`,
  );
  expect(report.passRate).toBeGreaterThanOrEqual(Number(process.env.EVAL_MIN_PASS_RATE ?? 0.9));
  expect(report.removedRate).toBeLessThanOrEqual(Number(process.env.EVAL_MAX_REMOVED_RATE ?? 0.2));
});
