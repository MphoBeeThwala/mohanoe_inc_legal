// Audit rows are not encrypted, so free text staff type (task, document,
// notification and report titles, which may name clients) must never reach
// them. Summaries carry the matter number and kinds instead.
import { beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import app from '../server';
import { db } from '../db/client';
import { auditEvents } from '../db/schema';
import { createStaff, inDefaultFirm, type TestStaff } from './helpers';

const NAME = 'Nomvula Dlamini-Khumalo';
let attorney: TestStaff;

beforeAll(async () => {
  attorney = await createStaff({ email: 'attorney@audit-privacy.example', role: 'attorney' });
});

test('titles that name a client never reach the audit trail', async () => {
  const as = (r: request.Test) => r.set(attorney.auth);
  const check = await as(request(app).post('/api/conflicts')).send({
    subjects: [{ name: NAME }],
    purpose: 'New instruction',
  });
  await as(request(app).post(`/api/conflicts/${check.body.id}/decision`)).send({
    decision: 'clear',
  });
  const client = await as(request(app).post('/api/clients')).send({
    kind: 'individual',
    details: { name: NAME },
    conflictCheckId: check.body.id,
  });
  const matter = await as(request(app).post('/api/cases')).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title: 'Sale of property',
    practiceArea: 'Conveyancing',
  });
  expect(matter.status, JSON.stringify(matter.body)).toBe(201);
  const caseId = matter.body.id as string;

  const task = await as(request(app).post(`/api/cases/${caseId}/tasks`)).send({
    title: `Call ${NAME} about transfer`,
  });
  expect(task.status, JSON.stringify(task.body)).toBe(201);
  expect(
    (await as(request(app).post(`/api/cases/${caseId}/tasks/${task.body.id}/complete`))).status,
  ).toBeLessThan(300);

  const document = await as(request(app).post('/api/documents')).send({
    caseId,
    title: `Offer to purchase for ${NAME}`,
    body: 'Terms',
  });
  expect(document.status, JSON.stringify(document.body)).toBe(201);
  expect(
    (await as(request(app).post(`/api/documents/${document.body.id}/sign`))).status,
  ).toBeLessThan(300);

  const notice = await as(request(app).post('/api/notifications')).send({
    title: `${NAME} called back`,
    body: 'Please return the call',
    category: 'general',
  });
  expect(notice.status, JSON.stringify(notice.body)).toBe(201);
  expect(
    (await as(request(app).post(`/api/notifications/${notice.body.id}/read`))).status,
  ).toBeLessThan(300);

  const report = await as(request(app).post('/api/reports')).send({
    title: `Matters for ${NAME}`,
  });
  expect(report.status, JSON.stringify(report.body)).toBe(201);

  const rows = await inDefaultFirm(() => db().select().from(auditEvents));
  const actions = rows.map((row) => row.action);
  expect(actions).toEqual(
    expect.arrayContaining([
      'task_created',
      'task_completed',
      'document_created',
      'document_signed',
      'notification_created',
      'notification_read',
      'report_generated',
    ]),
  );
  const text = JSON.stringify(rows.map(({ summary, details }) => ({ summary, details })));
  expect(text).not.toContain('Nomvula');
  expect(text).not.toContain('Dlamini');
  expect(rows.find((row) => row.action === 'task_created')?.summary).toBe(
    `Task created on ${matter.body.caseNumber}`,
  );
});
