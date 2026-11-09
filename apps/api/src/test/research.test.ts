// AI client, triage without fallbacks, metering and caps, and de-identified
// research briefs (preview, edit, re-check, confirm), with a fake model.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import app from '../server';
import { db } from '../db/client';
import { aiCalls } from '../db/schema';
import { setAiClient, type AiClient, type AiRequest } from '../lib/ai-client';
import { httpError } from '../lib/http';
import { decryptJson } from '../services/privacy.service';
import { createStaff, inDefaultFirm, type TestStaff } from './helpers';

const sent: AiRequest[] = [];

const fakeModel = (answer: (request: AiRequest) => string): AiClient => ({
  provider: 'fake',
  async complete(req) {
    sent.push(req);
    return {
      text: answer(req),
      provider: 'fake',
      model: 'fake-model-1',
      inputTokens: 1200,
      outputTokens: 300,
      stopReason: 'end_turn',
    };
  },
});

const TRIAGE_ANSWER = JSON.stringify({
  matterType: 'Housing',
  urgency: 'high',
  summary: '[Client] faces eviction by [Opposing party] after a lease dispute.',
  keyFacts: ['Locks were changed'],
  attorneyQuestions: ['Was a court order obtained?'],
  recommendedDocuments: ['Lease'],
  complianceFlags: [],
  nextActions: ['Check for a court order'],
  confidence: 0.8,
});

let admin: TestStaff;
let attorney: TestStaff;
let secretary: TestStaff;
let outsider: TestStaff;
let caseId = '';

const intake = {
  fullName: 'Thandiwe Nkosi',
  email: 'thandi.n@example.co.za',
  phone: '082 555 1234',
  practiceArea: 'Housing',
  matterSummary:
    'Thandiwe Nkosi rents a flat at 14 Jacaranda Street. On 3 March 2024 the landlord changed the locks. Her ID is 8503120123084.',
  requestedOutcome: 'Thandiwe wants to be let back in.',
  consentToAi: true,
  consentToStorage: true,
};

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@research.example', role: 'admin' });
  attorney = await createStaff({ email: 'attorney@research.example', role: 'attorney' });
  secretary = await createStaff({ email: 'secretary@research.example', role: 'secretary' });
  outsider = await createStaff({ email: 'other@research.example', role: 'attorney' });
});

afterEach(() => {
  setAiClient(undefined);
  delete process.env.AI_FIRM_MONTHLY_TOKENS;
  sent.length = 0;
});

async function submitIntake() {
  const created = await request(app)
    .post('/api/intake/submissions')
    .set(attorney.auth)
    .send(intake);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id as string;
}

describe('triage', () => {
  test('without AI configured, a matter opens as "not assessed" (no invented advice)', async () => {
    setAiClient(null);
    const id = await submitIntake();
    const res = await request(app).post(`/api/intake/submissions/${id}/assess`).set(attorney.auth);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.assessment).toMatchObject({ provider: 'none', confidence: 0 });
    expect(res.body.assessment.summary).toMatch(/Not assessed by AI/);
    expect(res.body.assessment.attorneyQuestions).toEqual([]);
  });

  test('the model only ever sees the de-identified intake, and every call is metered', async () => {
    setAiClient(fakeModel(() => TRIAGE_ANSWER));
    const id = await submitIntake();
    const res = await request(app).post(`/api/intake/submissions/${id}/assess`).set(attorney.auth);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.assessment).toMatchObject({ provider: 'fake', urgency: 'high' });
    caseId = res.body.matterCase.id;

    const prompt = JSON.stringify(sent);
    for (const secret of [
      'Thandiwe',
      'Nkosi',
      '8503120123084',
      '555 1234',
      'thandi.n@',
      'Jacaranda',
    ]) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain('[Client]');

    const calls = await inDefaultFirm(() => db().select().from(aiCalls));
    const triage = calls.find((call) => call.subjectId === id)!;
    expect(triage).toMatchObject({ purpose: 'triage', status: 'ok', inputTokens: 1200 });
    // The logged prompt is encrypted at rest.
    expect(triage.promptEncrypted).toMatch(/^v2:/);
    const logged = await inDefaultFirm(() =>
      decryptJson<{ system: string }>(triage.promptEncrypted!),
    );
    expect(logged?.system).toMatch(/de-identified/);
  });

  test('a failed or malformed AI answer is an error, not a quiet fallback', async () => {
    const id = await submitIntake();
    setAiClient({
      provider: 'fake',
      complete: async () => {
        throw httpError('The AI service failed (500). Please try again.', 502);
      },
    });
    const failed = await request(app)
      .post(`/api/intake/submissions/${id}/assess`)
      .set(attorney.auth);
    expect(failed.status).toBe(502);
    expect(failed.body.message).toMatch(/AI service failed/);

    setAiClient(fakeModel(() => 'I think this is a housing matter.'));
    const garbled = await request(app)
      .post(`/api/intake/submissions/${id}/assess`)
      .set(attorney.auth);
    expect(garbled.status).toBe(502);
    expect(garbled.body.message).toMatch(/expected format/);
  });

  test("a firm's monthly allowance caps its AI use; administrators see usage", async () => {
    setAiClient(fakeModel(() => TRIAGE_ANSWER));
    process.env.AI_FIRM_MONTHLY_TOKENS = '1000';
    const id = await submitIntake();
    const capped = await request(app)
      .post(`/api/intake/submissions/${id}/assess`)
      .set(attorney.auth);
    expect(capped.status).toBe(429);
    expect(capped.body.message).toMatch(/allowance for the month/);

    const usage = await request(app).get('/api/ai/usage').set(admin.auth);
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({ tokenLimit: 1000, configured: true });
    expect(usage.body.tokensUsed).toBeGreaterThanOrEqual(1500);
    expect((await request(app).get('/api/ai/usage').set(attorney.auth)).status).toBe(403);
  });
});

describe('research briefs', () => {
  test('a draft brief combines question and facts, de-identified against the matter’s parties', async () => {
    const party = await request(app)
      .post(`/api/cases/${caseId}/parties`)
      .set(attorney.auth)
      .send({
        role: 'opposing',
        party: {
          kind: 'individual',
          details: { name: 'Pieter van der Merwe', idNumber: '7001015009087' },
        },
      });
    expect(party.status, JSON.stringify(party.body)).toBe(201);

    const res = await request(app).post(`/api/cases/${caseId}/research`).set(attorney.auth).send({
      question: 'Can Pieter van der Merwe lock Thandiwe out without a court order?',
      additionalFacts: 'Van der Merwe (ID 700101 5009 087) said Sipho would move in.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.question).toContain('Pieter van der Merwe');
    const brief: string = res.body.brief;
    expect(brief).toContain('Can [Opposing party] lock [Client] out without a court order?');
    for (const secret of [
      'Pieter',
      'Merwe',
      'Thandiwe',
      '7001015009087',
      '700101',
      '8503120123084',
      'Jacaranda',
    ]) {
      expect(brief).not.toContain(secret);
    }
    expect(brief).toContain('3 March 2024');
    expect(res.body.warnings).toContain('Sipho');
    expect(res.body.replacements.length).toBeGreaterThan(2);
    // Nothing went to a model.
    expect(sent).toHaveLength(0);
  });

  test('edits are checked again: putting a name or identifier back is refused', async () => {
    const [draft] = (await request(app).get(`/api/cases/${caseId}/research`).set(attorney.auth))
      .body;
    const leaked = await request(app)
      .patch(`/api/research/${draft.id}`)
      .set(attorney.auth)
      .send({ brief: `${draft.brief}\nThe client's number is 082 555 1234 (Thandiwe Nkosi).` });
    expect(leaked.status).toBe(422);
    expect(leaked.body.message).toMatch(/personal information/);

    const edited = await request(app)
      .patch(`/api/research/${draft.id}`)
      .set(attorney.auth)
      .send({ brief: draft.brief.replace('Sipho', 'another person') });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.warnings).not.toContain('Sipho');

    const confirmed = await request(app)
      .post(`/api/research/${draft.id}/confirm`)
      .set(attorney.auth);
    expect(confirmed.body).toMatchObject({ status: 'confirmed', confirmedBy: attorney.id });
    const locked = await request(app)
      .patch(`/api/research/${draft.id}`)
      .set(attorney.auth)
      .send({ brief: 'Anything' });
    expect(locked.status).toBe(409);
    expect((await request(app).delete(`/api/research/${draft.id}`).set(attorney.auth)).status).toBe(
      409,
    );
  });

  test('research needs research.use and access to the matter', async () => {
    expect(
      (await request(app).get(`/api/cases/${caseId}/research`).set(secretary.auth)).status,
    ).toBe(403);
    // Restrict the matter to its team: another attorney can no longer see it.
    const restricted = await request(app)
      .put(`/api/cases/${caseId}/access`)
      .set(attorney.auth)
      .send({ access: 'restricted' });
    expect(restricted.status, JSON.stringify(restricted.body)).toBeLessThan(300);
    const [draft] = (await request(app).get(`/api/cases/${caseId}/research`).set(attorney.auth))
      .body;
    expect(
      (await request(app).get(`/api/cases/${caseId}/research`).set(outsider.auth)).status,
    ).toBe(404);
    expect((await request(app).get(`/api/research/${draft.id}`).set(outsider.auth)).status).toBe(
      404,
    );
    expect(
      (
        await request(app)
          .post(`/api/cases/${caseId}/research`)
          .set(outsider.auth)
          .send({ question: 'x' })
      ).status,
    ).toBe(404);
  });
});
