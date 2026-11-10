// Court Online numbers on matters, which courts use Court Online, and court
// roll notices to the matter team plus the firm's watchers (office manager):
// new listings, changed listings on amended rolls, and reminders for
// listings nobody has confirmed.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import PDFDocument from 'pdfkit';
import app from '../server';
import { testOutbox } from '../services/mail.service';
import type { FetchedDocument } from '../services/court-roll-sources';
import { remindUnconfirmed, syncCourtRolls } from '../services/court-roll.service';
import { createStaff, inDefaultFirm, type TestStaff } from './helpers';

const HEADER = [
  '(GAUTENG DIVISION, PRETORIA)',
  'PRETORIA THIS 3 MARCH 2031',
  'MONDAY',
  'OPPOSED MOTIONS',
];
const ROLL = [
  ...HEADER,
  'IN COURT 4C AT 10:00',
  'BEFORE THE HONOURABLE JUSTICE KHUMALO J',
  '10907/22;',
  'CIVIL TRIALS',
  'IN COURT 6E AT 09:30',
  'BEFORE THE HONOURABLE JUSTICE HASSIM J',
  '114. WESBANK LTD VS ST AIR PROJECTS 040272/24',
];
// Amended: 10907/22 moves to court 5A at 11:30.
const AMENDED = [
  ...HEADER,
  'IN COURT 5A AT 11:30',
  'BEFORE THE HONOURABLE JUSTICE KHUMALO J',
  '10907/22;',
  'CIVIL TRIALS',
  'IN COURT 6E AT 09:30',
  'BEFORE THE HONOURABLE JUSTICE HASSIM J',
  '114. WESBANK LTD VS ST AIR PROJECTS 040272/24',
];

function pdf(lines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica').fontSize(10);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

const SOURCE = {
  division: 'ZAGPPHC',
  url: 'https://www.court.example/court-rolls',
  match: 'Pretoria',
};
const ROLL_URL = 'https://www.court.example/rolls/2031-03-03-pretoria-daily.pdf';
const LISTING = `<html><body><a href="/rolls/2031-03-03-pretoria-daily.pdf">03 March 2031 - Pretoria - Daily Court Roll</a></body></html>`;
const NOW = new Date('2031-03-01T08:00:00Z');

async function sync(lines: string[]) {
  const body = await pdf(lines);
  const files: Record<string, Buffer | string> = {
    'https://www.court.example/robots.txt': 'User-agent: *\n',
    [SOURCE.url]: LISTING,
    [ROLL_URL]: body,
  };
  return syncCourtRolls({
    sources: [SOURCE],
    fetcher: async (url: string): Promise<FetchedDocument> => {
      const file = files[url];
      if (file === undefined) throw new Error('HTTP 404');
      return {
        body: Buffer.isBuffer(file) ? file : Buffer.from(file),
        contentType: url.endsWith('.pdf') ? 'application/pdf' : 'text/html',
      };
    },
    now: NOW,
    pause: async () => {},
  });
}

let admin: TestStaff;
let attorney: TestStaff;
let officeManager: TestStaff;
let onlineMatter: { id: string; caseNumber: string };
let restrictedMatter: { id: string; caseNumber: string };

async function openMatter(name: string) {
  const check = await request(app)
    .post('/api/conflicts')
    .set(attorney.auth)
    .send({ subjects: [{ name }], purpose: 'Roll test' });
  await request(app)
    .post(`/api/conflicts/${check.body.id}/decision`)
    .set(attorney.auth)
    .send({ decision: 'clear' });
  const client = await request(app)
    .post('/api/clients')
    .set(attorney.auth)
    .send({ kind: 'individual', details: { name }, conflictCheckId: check.body.id });
  const opened = await request(app).post('/api/cases').set(attorney.auth).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title: 'Roll test',
    practiceArea: 'Litigation',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body as { id: string; caseNumber: string };
}

const mailFor = (who: TestStaff, since: number) =>
  testOutbox()
    .slice(since)
    .filter((m) => m.to === who.email);

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@online.example', role: 'admin' });
  attorney = await createStaff({ email: 'attorney@online.example', role: 'attorney' });
  officeManager = await createStaff({ email: 'office@online.example', role: 'secretary' });
  onlineMatter = await openMatter('Wesbank Matter');
  restrictedMatter = await openMatter('Confidential Matter');
});

describe('Court Online', () => {
  test('courts known to use Court Online are listed with their sources', async () => {
    const res = await request(app).get('/api/court-rolls/court-online').set(attorney.auth);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { division: string }) => c.division)).toEqual(
      expect.arrayContaining(['ZAGPPHC', 'ZAGPJHC', 'ZALCJHB']),
    );
    expect(res.body.every((c: { source: string }) => c.source.length > 10)).toBe(true);
  });

  test('a matter keeps its Court Online number; its court says whether it uses Court Online', async () => {
    const set = await request(app)
      .put(`/api/cases/${onlineMatter.id}/court`)
      .set(attorney.auth)
      .send({
        courtDivision: 'ZAGPPHC',
        courtCaseNumber: '55555/2024',
        courtOnlineReference: '040272/24',
      });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ courtOnlineReference: '040272/24' });
    const status = await request(app)
      .get(`/api/cases/${onlineMatter.id}/court-online`)
      .set(attorney.auth);
    expect(status.body.court).toMatchObject({ division: 'ZAGPPHC' });
    expect(status.body.url).toMatch(/^https:\/\//);

    const bad = await request(app)
      .put(`/api/cases/${onlineMatter.id}/court`)
      .set(attorney.auth)
      .send({
        courtDivision: 'ZAGPPHC',
        courtCaseNumber: '55555/2024',
        courtOnlineReference: 'not a number',
      });
    expect(bad.status).toBe(400);

    await request(app)
      .put(`/api/cases/${restrictedMatter.id}/court`)
      .set(attorney.auth)
      .send({ courtDivision: 'MAGISTRATE', courtCaseNumber: '10907/22' })
      .expect(200);
    const none = await request(app)
      .get(`/api/cases/${restrictedMatter.id}/court-online`)
      .set(attorney.auth);
    expect(none.body.court).toBeNull();
    // Back to the High Court for the roll tests.
    await request(app)
      .put(`/api/cases/${restrictedMatter.id}/court`)
      .set(attorney.auth)
      .send({ courtDivision: 'ZAGPPHC', courtCaseNumber: '10907/22' })
      .expect(200);
    await request(app)
      .put(`/api/cases/${restrictedMatter.id}/access`)
      .set(attorney.auth)
      .send({ access: 'restricted' })
      .expect((res) => expect(res.status).toBeLessThan(300));
  });
});

describe('court roll notices', () => {
  test('administrators choose who else hears about court rolls', async () => {
    expect(
      (
        await request(app)
          .put('/api/court-rolls/watchers')
          .set(attorney.auth)
          .send({ userIds: [officeManager.id] })
      ).status,
    ).toBe(403);
    const set = await request(app)
      .put('/api/court-rolls/watchers')
      .set(admin.auth)
      .send({ userIds: [officeManager.id] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await request(app).get('/api/court-rolls/watchers').set(attorney.auth)).body).toEqual({
      userIds: [officeManager.id],
    });
  });

  test('a listing (matched by its Court Online number) goes to the team and the office manager', async () => {
    const before = testOutbox().length;
    const report = await sync(ROLL);
    expect(report.matched).toBe(2);
    const attorneyMail = mailFor(attorney, before).map((m) => m.subject);
    expect(
      attorneyMail.some((s) => s.includes(`${onlineMatter.caseNumber} is on a court roll`)),
    ).toBe(true);
    expect(
      attorneyMail.some((s) => s.includes(`${restrictedMatter.caseNumber} is on a court roll`)),
    ).toBe(true);
    const managerMail = mailFor(officeManager, before).map((m) => m.subject);
    expect(managerMail.some((s) => s.includes(onlineMatter.caseNumber))).toBe(true);
    // A restricted matter's number only goes to watchers on the matter.
    expect(managerMail.some((s) => s.includes(restrictedMatter.caseNumber))).toBe(false);
  });

  test('an amended roll that moves a hearing sends one "listing changed" notice', async () => {
    const before = testOutbox().length;
    await sync(AMENDED);
    const subjects = mailFor(attorney, before).map((m) => m.subject);
    expect(subjects.filter((s) => s.includes(restrictedMatter.caseNumber))).toEqual([
      expect.stringContaining(`${restrictedMatter.caseNumber}: court roll listing changed`),
    ]);
    const body = mailFor(attorney, before).find((m) => m.subject.includes('listing changed'))!.text;
    expect(body).toMatch(/4C/);
    expect(body).toMatch(/5A/);
    // The unchanged listing isn't announced again.
    expect(subjects.some((s) => s.includes(onlineMatter.caseNumber))).toBe(false);
  });

  test('listings in the next two days that nobody confirmed get one reminder', async () => {
    const before = testOutbox().length;
    const sent = await inDefaultFirm(() => remindUnconfirmed(NOW));
    expect(sent).toBeGreaterThan(0);
    const subjects = mailFor(attorney, before).map((m) => m.subject);
    expect(
      subjects.some((s) =>
        s.includes(`${onlineMatter.caseNumber}: court roll listing not yet confirmed`),
      ),
    ).toBe(true);
    expect(
      mailFor(officeManager, before).some((m) => m.subject.includes(onlineMatter.caseNumber)),
    ).toBe(true);
    expect(await inDefaultFirm(() => remindUnconfirmed(NOW))).toBe(0);
  });
});
