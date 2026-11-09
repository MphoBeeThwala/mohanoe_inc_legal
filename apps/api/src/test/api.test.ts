import './memory-env';
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';

import app from '../server';

// HTTP-level tests against the real Express app (in-memory datastore).
let token: string;

beforeAll(async () => {
  const res = await request(app).post('/api/auth/register').send({
    fullName: 'Test Attorney',
    email: 'attorney@example.com',
    password: 'CorrectHorse123',
  });
  expect(res.status).toBe(201);
  token = res.body.token;
});

describe('public endpoints', () => {
  test('health check', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('legal-practice-api');
  });

  test('branding comes from configuration', async () => {
    const res = await request(app).get('/api/tenant/branding');
    expect(res.status).toBe(200);
    expect(res.body.firmName).toBe('Nkosi & Partners Inc.');
    expect(res.body.casePrefix).toBe('NKP');
    expect(res.body.platform.legalName).toBe('Ahava on 88 (Pty) Ltd');
  });

  test('security headers and request id are set', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('authentication and roles', () => {
  test('protected routes reject missing tokens', async () => {
    const res = await request(app).get('/api/cases');
    expect(res.status).toBe(401);
  });

  test('protected routes reject forged tokens', async () => {
    const res = await request(app).get('/api/cases').set('authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  test('me returns the signed-in user', async () => {
    const res = await request(app).get('/api/auth/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('attorney@example.com');
  });

  test('admin-only routes return 403 for an attorney', async () => {
    const auth = { authorization: `Bearer ${token}` };
    expect((await request(app).post('/api/auth/seed-admin').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/compliance/export').set(auth)).status).toBe(403);
  });
});

describe('intake to matter', () => {
  test('submission requires consent', async () => {
    const res = await request(app)
      .post('/api/intake/submissions')
      .set('authorization', `Bearer ${token}`)
      .send({
        fullName: 'Thandi Nkosi',
        email: 'thandi@example.com',
        phone: '0821234567',
        practiceArea: 'Family Law',
        matterSummary: 'Urgent custody matter',
        consentToAi: false,
        consentToStorage: true,
      });
    expect(res.status).toBe(400);
  });

  test('assessment creates a case numbered with the firm prefix, without leaking PII', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const created = await request(app)
      .post('/api/intake/submissions')
      .set(auth)
      .send({
        fullName: 'Thandi Nkosi',
        email: 'thandi@example.com',
        phone: '0821234567',
        practiceArea: 'Family Law',
        matterSummary: 'Thandi Nkosi needs urgent advice on custody; call 0821234567.',
        consentToAi: true,
        consentToStorage: true,
      });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain('thandi@example.com');
    expect(created.body.summary).not.toContain('Thandi');
    expect(created.body.summary).not.toContain('0821234567');

    const assessed = await request(app)
      .post(`/api/intake/submissions/${created.body.id}/assess`)
      .set(auth);
    expect(assessed.status).toBeLessThan(300);
    expect(assessed.body.matterCase.caseNumber).toMatch(/^NKP-\d{4}-\d{4}$/);
  });
});
