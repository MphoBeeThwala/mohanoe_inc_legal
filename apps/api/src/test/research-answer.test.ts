// Approved corpus, retrieval and verified, cited answers (epic 11b).
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import app from '../server';
import { setAiClient, type AiRequest } from '../lib/ai-client';
import {
  authorityFromCitation,
  importDocument,
  search,
  setSourceStatus,
  splitPassages,
  upsertSource,
} from '../services/corpus.service';
import {
  citationFor,
  passagesFromAknHtml,
  syncLawsAfrica,
  validityFor,
} from '../services/laws-africa';
import { verifyClaims, toCited } from '../services/research-run';
import { createFirm } from '../services/firm.service';
import { createStaff, inDefaultFirm, type TestStaff } from './helpers';

const sent: AiRequest[] = [];
let answerFor: (req: AiRequest) => string = () => '{}';

let attorney: TestStaff;
let paralegal: TestStaff;
let caseId = '';

const PIE_TEXT = `1. Definitions
In this Act an unlawful occupier means a person who occupies land without the express or tacit consent of the owner.
4. Eviction of unlawful occupiers
(1) Notwithstanding anything to the contrary contained in any law, the provisions of this section apply to proceedings by an owner for the eviction of an unlawful occupier.
(6) A court may grant an order for eviction if it is of the opinion that it is just and equitable to do so.
8. Prohibition of unlawful eviction
(1) No person may be evicted from land except on the authority of an order of a competent court.`;

beforeAll(async () => {
  attorney = await createStaff({ email: 'attorney@answers.example', role: 'attorney' });
  paralegal = await createStaff({ email: 'paralegal@answers.example', role: 'paralegal' });
  setAiClient({
    provider: 'fake',
    complete: async (req) => {
      sent.push(req);
      return {
        text: answerFor(req),
        provider: 'fake',
        model: 'fake-research',
        inputTokens: 100,
        outputTokens: 100,
        stopReason: 'end_turn',
      };
    },
  });

  await upsertSource({
    code: 'test-legislation',
    name: 'Test legislation feed',
    kind: 'legislation',
    licence: 'CC BY 4.0 (test)',
    approvedBy: 'ops@platform.test',
  });
  await upsertSource({
    code: 'test-reports',
    name: 'Test law reports',
    kind: 'case_law',
    licence: 'Licence agreement (test)',
    permission: 'Signed 2026-11-01, ref T-1',
    approvedBy: 'ops@platform.test',
  });
  await importDocument('test-legislation', {
    title: 'Prevention of Illegal Eviction from and Unlawful Occupation of Land Act',
    citation: 'Act 19 of 1998',
    text: PIE_TEXT,
    versionDate: '2026-01-01',
  });
  await importDocument('test-legislation', {
    title: 'Old Eviction Act',
    citation: 'Act 1 of 1950',
    validity: 'repealed',
    repealedDate: '1998-06-05',
    text: '1. Eviction\nAn owner may evict an unlawful occupier without a court order.\n2. Other\nNothing.',
  });
  await importDocument('test-reports', {
    title: 'Occupiers v City',
    citation: '[2012] ZACC 9',
    text: '[1] Eviction of an unlawful occupier requires a court order that is just and equitable.\n[2] The court must consider the rights of the occupiers.',
  });
  await importDocument('test-reports', {
    title: 'Owner v Occupier',
    citation: '[2015] ZAGPJHC 77',
    text: '[1] Eviction of an unlawful occupier requires a court order that is just and equitable.\n[2] Costs follow the result.',
  });
});

afterEach(() => {
  sent.length = 0;
});

describe('passages and metadata', () => {
  test('legislation splits into sections, judgments into paragraphs', () => {
    const sections = splitPassages(PIE_TEXT, 'legislation');
    expect(sections.map((p) => p.pinpoint)).toEqual(['section 1', 'section 4', 'section 8']);
    expect(splitPassages('[1] One.\n[2] Two.', 'case_law').map((p) => p.pinpoint)).toEqual([
      'para 1',
      'para 2',
    ]);
  });

  test('neutral citations map to the hierarchy of authority', () => {
    expect(authorityFromCitation('[2012] ZACC 9')).toBe(1);
    expect(authorityFromCitation('[2019] ZASCA 1')).toBe(2);
    expect(authorityFromCitation('[2015] ZAGPJHC 77')).toBe(3);
    expect(authorityFromCitation('Act 19 of 1998')).toBeNull();
  });

  test('Laws.Africa works: citation, validity, sections and repealed provisions', async () => {
    expect(citationFor({ frbr_uri: '/akn/za/act/1998/19', title: 'PIE Act' })).toBe(
      'Act 19 of 1998',
    );
    expect(validityFor({ repeal: { date: '2020-01-01' } })).toBe('repealed');
    expect(validityFor({ commenced: false })).toBe('not_commenced');
    const passages = passagesFromAknHtml(
      '<div><section class="akn-section" data-eid="sec_1"><h3>1. Definitions</h3><p>In this Act &amp; that.</p></section>' +
        '<section class="akn-section" data-eid="sec_2"><h3>2.</h3><p>[Section 2 repealed by Act 5 of 2000]</p></section></div>',
    );
    expect(passages).toEqual([
      {
        pinpoint: 'section 1',
        text: expect.stringContaining('In this Act & that.'),
        repealed: false,
      },
      { pinpoint: 'section 2', text: expect.any(String), repealed: true },
    ]);

    await upsertSource({
      code: 'laws-africa',
      name: 'Laws.Africa',
      kind: 'legislation',
      licence: 'Laws.Africa API terms (test)',
      approvedBy: 'ops@platform.test',
    });
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/akn/za/.json')) {
        return Response.json({
          next: null,
          results: [
            {
              url: 'https://api.laws.africa/v3/akn/za/act/2000/5/eng@2020-01-01',
              frbr_uri: '/akn/za/act/2000/5',
              title: 'Example Act',
              expression_date: '2020-01-01',
              nature: 'act',
            },
          ],
        });
      }
      return new Response(
        '<section class="akn-section" data-eid="sec_1"><h3>1.</h3><p>Example text about leases.</p></section>',
      );
    };
    const first = await syncLawsAfrica({ token: 't', fetcher, pauseMs: 0 });
    expect(first).toMatchObject({ seen: 1, imported: 1, failed: 0 });
    const second = await syncLawsAfrica({ token: 't', fetcher, pauseMs: 0 });
    expect(second).toMatchObject({ seen: 1, unchanged: 1, imported: 0 });
    // The second run didn't fetch the work's text again.
    expect(calls.filter((url) => url.endsWith('.html'))).toHaveLength(1);
  });
});

describe('search', () => {
  test('only approved sources and law in force, stronger authority first', async () => {
    const hits = await inDefaultFirm(() => search(['eviction unlawful occupier court order']));
    const citations = hits.map((hit) => hit.citation);
    expect(citations).toContain('Act 19 of 1998');
    expect(citations).not.toContain('Act 1 of 1950');
    // Same words: the Constitutional Court ranks above the High Court.
    expect(citations.indexOf('[2012] ZACC 9')).toBeLessThan(citations.indexOf('[2015] ZAGPJHC 77'));

    await setSourceStatus('test-reports', 'suspended');
    const without = await inDefaultFirm(() => search(['eviction unlawful occupier court order']));
    expect(without.map((hit) => hit.citation)).not.toContain('[2012] ZACC 9');
    await setSourceStatus('test-reports', 'approved');
  });

  test('staff can see which sources research draws on, with their licences', async () => {
    const res = await request(app).get('/api/research-sources').set(attorney.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'test-reports',
          licence: 'Licence agreement (test)',
          documents: 2,
        }),
      ]),
    );
  });
});

describe('firm precedents', () => {
  test('uploaded, de-identified, reviewed, approved: only then searchable, and only by the firm', async () => {
    const uploaded = await request(app).post('/api/precedents').set(attorney.auth).send({
      title: 'Opinion on lockouts',
      text: 'Mr Jacobs of 12 Oak Street (ID 8001015009087) was locked out. A landlord who changes the locks without a court order commits spoliation and the mandament van spolie restores possession.',
    });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    expect(uploaded.body.status).toBe('review');
    expect(uploaded.body.text).not.toMatch(/Jacobs|Oak Street|8001015009087/);
    expect(await inDefaultFirm(() => search(['spoliation mandament spolie']))).toHaveLength(0);

    const leak = await request(app)
      .patch(`/api/precedents/${uploaded.body.id}`)
      .set(attorney.auth)
      .send({ text: `${uploaded.body.text} Call 082 123 4567.` });
    expect(leak.status).toBe(422);

    expect(
      (await request(app).post(`/api/precedents/${uploaded.body.id}/approve`).set(paralegal.auth))
        .status,
    ).toBe(403);
    const approved = await request(app)
      .post(`/api/precedents/${uploaded.body.id}/approve`)
      .set(attorney.auth);
    expect(approved.body.status).toBe('approved');
    const hits = await inDefaultFirm(() => search(['spoliation mandament spolie']));
    expect(hits[0]).toMatchObject({ kind: 'precedent', sourceName: 'Firm precedent' });

    const other = await createFirm({
      slug: 'answers-other',
      legalName: 'Other Answers Inc',
      domains: ['portal.answers-other.test'],
    });
    const outsider = await createStaff({
      email: 'attorney@answers-other.example',
      role: 'attorney',
      firm: other,
      host: 'portal.answers-other.test',
    });
    const theirs = await request(app)
      .get('/api/precedents')
      .set('Host', 'portal.answers-other.test')
      .set(outsider.auth);
    expect(theirs.body).toEqual([]);
    expect(
      (
        await request(app)
          .get(`/api/precedents/${uploaded.body.id}`)
          .set('Host', 'portal.answers-other.test')
          .set(outsider.auth)
      ).status,
    ).toBe(404);
  });
});

describe('verified answers', () => {
  const sources = toCited([
    {
      key: 'a',
      rank: 1,
      kind: 'legislation',
      sourceName: 'Test',
      title: 'PIE Act',
      citation: 'Act 19 of 1998',
      pinpoint: 'section 8',
      url: '',
      versionDate: null,
      authorityLevel: 4,
      court: '',
      validity: 'in_force',
      effectiveDate: null,
      text: 'No person may be evicted from land except on the authority of an order of a competent court.',
    },
  ]);

  test('claims citing nothing, unknown sources, unquoted words or unretrieved authorities are removed', () => {
    const { claims, removed } = verifyClaims(
      {
        claims: [
          { text: 'Eviction needs a court order.', citations: ['S1'] },
          { text: 'The owner must give 30 days notice.', citations: [] },
          { text: 'Self-help is allowed.', citations: ['S9'] },
          { text: 'The Act says "an owner may always evict".', citations: ['S1'] },
          { text: 'See also [2001] ZACC 99 on this.', citations: ['S1'] },
          {
            text: 'It says "except on the authority of an order of a competent court".',
            citations: ['[S1]'],
          },
        ],
      },
      sources,
    );
    expect(claims.map((c) => c.text)).toEqual([
      'Eviction needs a court order.',
      'It says "except on the authority of an order of a competent court".',
    ]);
    expect(removed.map((r) => r.reason)).toEqual([
      'Cited no source',
      'Cited a source that was not retrieved',
      'Quoted words that are not in the cited source',
      'Named an authority that was not retrieved',
    ]);
  });

  test('a confirmed brief is researched, verified, shown with names to staff, then approved and frozen', async () => {
    const intake = await request(app).post('/api/intake/submissions').set(attorney.auth).send({
      fullName: 'Grace Mahlangu',
      email: 'grace@example.co.za',
      phone: '0731112222',
      practiceArea: 'Housing',
      matterSummary: 'Grace Mahlangu was locked out of her rented room without a court order.',
      consentToAi: true,
      consentToStorage: true,
    });
    answerFor = () => '{"matterType":"Housing","urgency":"high","summary":"x","confidence":0.5}';
    const assessed = await request(app)
      .post(`/api/intake/submissions/${intake.body.id}/assess`)
      .set(attorney.auth);
    caseId = assessed.body.matterCase.id;

    const draft = await request(app)
      .post(`/api/cases/${caseId}/research`)
      .set(attorney.auth)
      .send({ question: 'Can Grace be evicted without a court order?' });
    expect(
      (await request(app).post(`/api/research/${draft.body.id}/run`).set(attorney.auth)).status,
    ).toBe(409);
    await request(app).post(`/api/research/${draft.body.id}/confirm`).set(attorney.auth);

    sent.length = 0;
    answerFor = (req) =>
      req.system.includes('plan searches')
        ? '{"queries":["eviction unlawful occupier court order","[Client] eviction"]}'
        : JSON.stringify({
            claims: [
              { text: '[Client] may not be evicted without a court order.', citations: ['S1'] },
              { text: 'A notice period of 30 days applies.', citations: [] },
            ],
            gaps: ['Whether the room is "land" was not addressed.'],
            noAuthority: false,
          });
    const run = await request(app).post(`/api/research/${draft.body.id}/run`).set(paralegal.auth);
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.status).toBe('answered');
    const answer = run.body.answer;
    expect(answer.claims).toHaveLength(1);
    expect(answer.removed).toEqual([
      { text: 'A notice period of 30 days applies.', reason: 'Cited no source' },
    ]);
    expect(answer.claimsNamed[0].text).toBe(
      'Grace Mahlangu may not be evicted without a court order.',
    );
    expect(answer.sources.map((s: { citation: string }) => s.citation)).not.toContain(
      'Act 1 of 1950',
    );
    expect(answer.queries).toEqual(['eviction unlawful occupier court order', 'eviction']);

    // Neither call carried the client's details; the answer call carried the sources.
    const prompts = JSON.stringify(sent);
    expect(prompts).not.toMatch(/Grace|Mahlangu|0731112222|grace@/);
    expect(sent[1]!.messages[0]!.content).toContain('[S1]');

    expect(
      (await request(app).post(`/api/research/${draft.body.id}/approve`).set(paralegal.auth))
        .status,
    ).toBe(403);
    const approved = await request(app)
      .post(`/api/research/${draft.body.id}/approve`)
      .set(attorney.auth)
      .send({ note: 'Checked against the Act.' });
    expect(approved.body).toMatchObject({
      status: 'approved',
      approvalNote: 'Checked against the Act.',
    });
    expect(
      (await request(app).post(`/api/research/${draft.body.id}/run`).set(attorney.auth)).status,
    ).toBe(409);
  });

  test('nothing retrieved means "no authority found", without asking the model to answer', async () => {
    const draft = await request(app)
      .post(`/api/cases/${caseId}/research`)
      .set(attorney.auth)
      .send({ question: 'What is the VAT treatment of cryptocurrency mining?' });
    await request(app).post(`/api/research/${draft.body.id}/confirm`).set(attorney.auth);
    sent.length = 0;
    answerFor = () => '{"queries":["cryptocurrency mining value added tax"]}';
    const run = await request(app).post(`/api/research/${draft.body.id}/run`).set(attorney.auth);
    expect(run.body.answer).toMatchObject({ noAuthority: true, claims: [], sources: [] });
    expect(sent).toHaveLength(1);
  });
});
