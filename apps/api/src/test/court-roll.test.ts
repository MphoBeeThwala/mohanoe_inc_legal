// Court roll sync: reading rolls, fetching politely, matching with matters,
// amendments, accepting and dismissing, uploads, permissions and isolation.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import app from '../server';
import { db, rootDb } from '../db/client';
import {
  auditEvents,
  courtRollDocuments,
  courtRollEntries,
  courtRollMatches,
  notifications,
} from '../db/schema';
import { createFirm } from '../services/firm.service';
import { testOutbox } from '../services/mail.service';
import { parseRoll, firstDate } from '../services/court-roll-parser';
import {
  configuredSources,
  robotsAllows,
  rollLinks,
  type FetchedDocument,
} from '../services/court-roll-sources';
import { rollIdentity, syncCourtRolls } from '../services/court-roll.service';
import { createStaff, inDefaultFirm, type TestStaff } from './helpers';

const ROLL_LINES = [
  '(GAUTENG DIVISION, PRETORIA)',
  'PRETORIA THIS 3 MARCH 2031',
  'MONDAY',
  'OPPOSED MOTIONS',
  'IN COURT 4C AT 10:00',
  'BEFORE THE HONOURABLE JUSTICE KHUMALO J',
  '076666/23;    10907/22;',
  'CIVIL TRIALS',
  'IN COURT 6E AT 09:30',
  'BEFORE THE HONOURABLE JUSTICE HASSIM J',
  'BEFORE THE HONOURABLE JUSTICE MAHOSI J',
  '114. WESBANK LTD VS ST AIR PROJECTS 040272/24',
  'Tel: 012 492 6768, letter dated 13/07/2023',
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

const LISTING = `<html><body>
  <a href="/rolls/2031-03-03-pretoria-daily.pdf">03 March 2031 - Pretoria - Daily Court Roll</a>
  <a href="https://www.court.example/rolls/jhb.pdf">03 March 2031 - Johannesburg - Daily Court Roll</a>
  <a href="/private/roll.pdf">04 March 2031 - Pretoria - Special Roll</a>
  <a href="/rolls/old.pdf">10 July 2023 - Pretoria - Daily Court Roll</a>
  <a href="http://www.court.example/rolls/insecure.pdf">05 March 2031 - Pretoria - Roll</a>
  <a href="/about">About the court</a>
</body></html>`;

const ROBOTS = 'User-agent: *\nDisallow: /private/\n';

function fakeSite(files: Record<string, Buffer | string>) {
  const requested: string[] = [];
  const fetcher = async (url: string): Promise<FetchedDocument> => {
    requested.push(url);
    const body = files[url];
    if (body === undefined) throw new Error('HTTP 404');
    return {
      body: Buffer.isBuffer(body) ? body : Buffer.from(body),
      contentType: url.endsWith('.pdf') ? 'application/pdf' : 'text/html',
    };
  };
  return { fetcher, requested };
}

const SOURCE = {
  division: 'ZAGPPHC',
  url: 'https://www.court.example/court-rolls',
  match: 'Pretoria',
};
const NOW = new Date('2031-03-01T08:00:00Z');
const ROLL_URL = 'https://www.court.example/rolls/2031-03-03-pretoria-daily.pdf';

let attorney: TestStaff;
let bookkeeper: TestStaff;
let matterId: string;
let matterNumber: string;

async function openMatter(staff: TestStaff, name: string, host?: string) {
  const as = (r: request.Test) => (host ? r.set('Host', host) : r).set(staff.auth);
  const check = await as(request(app).post('/api/conflicts')).send({
    subjects: [{ name }],
    purpose: 'Roll test',
  });
  await as(request(app).post(`/api/conflicts/${check.body.id}/decision`)).send({
    decision: 'clear',
  });
  const client = await as(request(app).post('/api/clients')).send({
    kind: 'individual',
    details: { name },
    conflictCheckId: check.body.id,
  });
  const opened = await as(request(app).post('/api/cases')).send({
    clientId: client.body.id,
    conflictCheckId: check.body.id,
    title: 'Roll test',
    practiceArea: 'Litigation',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return opened.body as { id: string; caseNumber: string };
}

beforeAll(async () => {
  attorney = await createStaff({ email: 'attorney@roll.example', role: 'attorney' });
  bookkeeper = await createStaff({ email: 'books@roll.example', role: 'bookkeeper' });
  const matter = await openMatter(attorney, 'Thandi Mokoena');
  matterId = matter.id;
  matterNumber = matter.caseNumber;
  await request(app)
    .put(`/api/cases/${matterId}/court`)
    .set(attorney.auth)
    .send({ courtDivision: 'ZAGPPHC', courtCaseNumber: '2023-076666' })
    .expect(200);
});

describe('reading rolls', () => {
  test('hearings: date, section, courtroom, time, judges and case numbers only', () => {
    const roll = parseRoll(ROLL_LINES.join('\n'), '');
    expect(roll.rollDate).toBe('2031-03-03');
    expect(roll.hearings).toEqual([
      {
        caseKey: '76666/2023',
        hearingDate: '2031-03-03',
        hearingTime: '10:00',
        courtroom: '4C',
        judge: 'KHUMALO J',
        section: 'Opposed motions',
      },
      expect.objectContaining({ caseKey: '10907/2022', courtroom: '4C' }),
      {
        caseKey: '40272/2024',
        hearingDate: '2031-03-03',
        hearingTime: '09:30',
        courtroom: '6E',
        judge: 'HASSIM J and MAHOSI J',
        section: 'Civil trials',
      },
    ]);
    // Phone numbers and dates are not case numbers.
    expect(roll.hearings.map((hearing) => hearing.caseKey)).not.toContain('13/2007');
  });

  test('weekly rolls with day headings', () => {
    const roll = parseRoll(
      [
        'OPPOSED MOTIONS ROLL',
        'Thursday, 8 June @ 10:00',
        '1. ROAD ACCIDENT FUND VS SHERIFF +4 028726/23 (1-2 HRS)',
        'FRIDAY 9 JUNE 2023',
        'IN COURT 2C',
        '375/22',
      ].join('\n'),
      '5 - 9 June 2023 - Pretoria - Opposed Motion Roll',
    );
    expect(roll.rollDate).toBe('2023-06-05');
    expect(roll.hearings).toEqual([
      expect.objectContaining({
        caseKey: '28726/2023',
        hearingDate: '2023-06-08',
        hearingTime: '10:00',
      }),
      expect.objectContaining({ caseKey: '375/2022', hearingDate: '2023-06-09', courtroom: '2C' }),
    ]);
  });

  test('dates in roll titles', () => {
    expect(firstDate('22 - 26 January 2024 - Bloemfontein - Amended First Weekly Roll')).toBe(
      '2024-01-22',
    );
    expect(firstDate('29 January - 02 February 2024 - Bloemfontein - Second Weekly Roll')).toBe(
      '2024-01-29',
    );
    expect(firstDate('30 December - 03 January 2025 - Recess roll')).toBe('2024-12-30');
    expect(firstDate('Gauteng High Court Pretoria Day Roll 2026-05-14')).toBe('2026-05-14');
    expect(firstDate('Practice directive')).toBeNull();
    expect(rollIdentity('Amended First Weekly Roll (as at 16-1-2024)')).toBe(
      rollIdentity('First Weekly Roll'),
    );
  });
});

describe('fetching', () => {
  test('listing links: https only, filtered, absolute', () => {
    const links = rollLinks(LISTING, SOURCE.url, 'Pretoria');
    expect(links.map((link) => link.url)).toEqual([
      ROLL_URL,
      'https://www.court.example/private/roll.pdf',
      'https://www.court.example/rolls/old.pdf',
    ]);
    expect(links[0]).toMatchObject({ rollDate: '2031-03-03' });
  });

  test('robots.txt', () => {
    expect(robotsAllows(ROBOTS, '/private/roll.pdf')).toBe(false);
    expect(robotsAllows(ROBOTS, '/rolls/a.pdf')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /rolls/', '/rolls/a.pdf')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /', '/court-rolls')).toBe(false);
    expect(robotsAllows('', '/anything')).toBe(true);
  });

  test('sources come from COURT_ROLL_SOURCES and must use https', () => {
    expect(configuredSources('')).toEqual([]);
    expect(configuredSources(JSON.stringify([SOURCE]))).toEqual([
      { ...SOURCE, maxDocuments: undefined },
    ]);
    expect(() => configuredSources('[{"division":"ZAGPPHC","url":"http://x.example/"}]')).toThrow(
      /https/,
    );
    expect(() => configuredSources('{"oops":1}')).toThrow(/JSON array/);
  });
});

describe('sync', () => {
  test('a new roll is stored without names and matched with the firm, once', async () => {
    const roll = await pdf(ROLL_LINES);
    const site = fakeSite({
      'https://www.court.example/robots.txt': ROBOTS,
      [SOURCE.url]: LISTING,
      [ROLL_URL]: roll,
    });
    const before = testOutbox().length;
    const report = await syncCourtRolls({
      sources: [SOURCE],
      fetcher: site.fetcher,
      now: NOW,
      pause: async () => {},
    });
    expect(report.sources[0]).toMatchObject({ listed: 2, fetched: 1, stored: 1, failed: 0 });
    expect(report.matched).toBe(1);
    // Disallowed by robots.txt, filtered out, too old or not https: not fetched.
    expect(site.requested).not.toContain('https://www.court.example/private/roll.pdf');
    expect(site.requested).not.toContain('https://www.court.example/rolls/jhb.pdf');
    expect(site.requested).not.toContain('https://www.court.example/rolls/old.pdf');

    const stored = await rootDb().select().from(courtRollEntries);
    expect(stored.map((entry) => entry.caseKey).sort()).toEqual([
      '10907/2022',
      '40272/2024',
      '76666/2023',
    ]);
    const everything = JSON.stringify([stored, await rootDb().select().from(courtRollDocuments)]);
    expect(everything).not.toContain('WESBANK');

    const matches = await request(app).get('/api/court-rolls/matches').set(attorney.auth);
    expect(matches.body).toEqual([
      expect.objectContaining({
        caseId: matterId,
        caseNumber: matterNumber,
        courtCaseNumber: '2023-076666',
        origin: 'sync',
        documentUrl: ROLL_URL,
        hearingDate: '2031-03-03',
        hearingTime: '10:00',
        courtroom: '4C',
        judge: 'KHUMALO J',
        section: 'Opposed motions',
        status: 'new',
        onCalendar: false,
      }),
    ]);
    const mail = testOutbox().slice(before);
    expect(mail.map((message) => message.to)).toEqual([attorney.email]);
    expect(mail[0]!.text).toContain(matterNumber);
    expect(mail[0]!.text).not.toContain('Mokoena');

    // The same roll again: nothing new.
    const again = await syncCourtRolls({
      sources: [SOURCE],
      fetcher: site.fetcher,
      now: NOW,
      pause: async () => {},
    });
    expect(again.sources[0]).toMatchObject({ stored: 0, unchanged: 1 });
    expect(again.matched).toBe(0);
    expect(testOutbox().length).toBe(before + 1);
  });

  test('accepting puts the hearing on the calendar; it is then shown as on the calendar', async () => {
    const [match] = (await request(app).get('/api/court-rolls/matches').set(attorney.auth)).body;
    expect(
      (await request(app).post(`/api/court-rolls/matches/${match.id}/accept`).set(bookkeeper.auth))
        .status,
    ).toBe(403);
    const accepted = await request(app)
      .post(`/api/court-rolls/matches/${match.id}/accept`)
      .set(attorney.auth)
      .send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', onCalendar: true });
    const event = (
      await request(app).get(`/api/calendar/${accepted.body.eventId}`).set(attorney.auth)
    ).body;
    expect(event).toMatchObject({
      eventType: 'court_date',
      source: 'court_roll',
      startsAt: '2031-03-03T08:00:00.000Z',
      location: 'Court 4C, Gauteng Division, Pretoria',
      title: 'Opposed motions (from the court roll)',
    });
    expect(event.notes).toContain('KHUMALO J');
    expect(
      (await request(app).post(`/api/court-rolls/matches/${match.id}/accept`).set(attorney.auth))
        .status,
    ).toBe(409);
    expect(
      (await request(app).post(`/api/court-rolls/matches/${match.id}/dismiss`).set(attorney.auth))
        .status,
    ).toBe(409);
  });

  test('an amended roll without the matter flags it, keeps the calendar entry and tells the team', async () => {
    const amended = await pdf(ROLL_LINES.filter((line) => !line.startsWith('076666')));
    const site = fakeSite({
      'https://www.court.example/robots.txt': ROBOTS,
      [SOURCE.url]: LISTING,
      [ROLL_URL]: amended,
    });
    const before = testOutbox().length;
    const report = await syncCourtRolls({
      sources: [SOURCE],
      fetcher: site.fetcher,
      now: NOW,
      pause: async () => {},
    });
    expect(report.removed).toBe(1);
    const docs = await rootDb().select().from(courtRollDocuments);
    expect(docs.map((doc) => doc.status).sort()).toEqual(['active', 'superseded']);

    const removed = await request(app)
      .get('/api/court-rolls/matches?status=removed')
      .set(attorney.auth);
    expect(removed.body).toHaveLength(1);
    expect(removed.body[0].eventId).toBeTruthy();
    const event = await request(app)
      .get(`/api/calendar/${removed.body[0].eventId}`)
      .set(attorney.auth);
    expect(event.body.status).toBe('scheduled');
    const mail = testOutbox().slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain('no longer on an amended roll');
    const inApp = await inDefaultFirm(() =>
      db()
        .select()
        .from(notifications)
        .where(eq(notifications.relatedEntityId, removed.body[0].id)),
    );
    expect(inApp.length).toBeGreaterThanOrEqual(2);
  });

  test('a failed download or unreadable roll is reported, not fatal', async () => {
    const site = fakeSite({
      'https://www.court.example/robots.txt': ROBOTS,
      [SOURCE.url]: LISTING.replace('2031-03-03-pretoria-daily.pdf', 'broken.pdf'),
      'https://www.court.example/rolls/broken.pdf': Buffer.from('not a pdf'),
    });
    const report = await syncCourtRolls({
      sources: [SOURCE, { division: 'ZAWCHC', url: 'https://down.example/rolls' }],
      fetcher: site.fetcher,
      now: NOW,
      pause: async () => {},
    });
    expect(report.sources[0]).toMatchObject({ fetched: 1, failed: 1 });
    expect(report.sources[1]!.error).toBeTruthy();
    const [failed] = await rootDb()
      .select()
      .from(courtRollDocuments)
      .where(eq(courtRollDocuments.status, 'failed'));
    expect(failed?.error).toBeTruthy();
  });
});

describe('uploads', () => {
  test("an uploaded roll matches only the firm's own matters and is not stored", async () => {
    const other = await openMatter(attorney, 'Pieter Swart');
    await request(app)
      .put(`/api/cases/${other.id}/court`)
      .set(attorney.auth)
      .send({ courtDivision: 'ZAGPJHC', courtCaseNumber: '55555/2030' })
      .expect(200);
    const roll = await pdf([
      'JOHANNESBURG THIS 10 MARCH 2031',
      'UNOPPOSED MOTIONS',
      'IN COURT 7E AT 10:00',
      '1. SWART P VS SWART M 55555/2030',
    ]);
    const documents = (await rootDb().select().from(courtRollDocuments)).length;
    const upload = (staff: TestStaff, body: Record<string, unknown>) =>
      request(app).post('/api/court-rolls/upload').set(staff.auth).send(body);
    const body = {
      division: 'ZAGPJHC',
      fileName: 'Swart unopposed roll.pdf',
      contentType: 'application/pdf',
      contentBase64: roll.toString('base64'),
    };
    expect((await upload(bookkeeper, body)).status).toBe(403);
    const res = await upload(attorney, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hearings).toBe(1);
    expect(res.body.matches).toEqual([
      expect.objectContaining({
        caseId: other.id,
        origin: 'upload',
        documentUrl: null,
        hearingDate: '2031-03-10',
        courtroom: '7E',
      }),
    ]);
    expect((await rootDb().select().from(courtRollDocuments)).length).toBe(documents);
    const trail = await inDefaultFirm(() =>
      db().select().from(auditEvents).where(eq(auditEvents.action, 'court_roll_uploaded')),
    );
    expect(JSON.stringify(trail)).not.toContain('Swart');

    expect(
      (await upload(attorney, { ...body, contentBase64: Buffer.from('MZ\x90').toString('base64') }))
        .status,
    ).toBe(400);
    expect((await upload(attorney, { ...body, division: 'NARNIA' })).status).toBe(400);

    const dismissed = await request(app)
      .post(`/api/court-rolls/matches/${res.body.matches[0].id}/dismiss`)
      .set(attorney.auth);
    expect(dismissed.body.status).toBe('dismissed');
  });
});

describe('isolation', () => {
  test('walled staff see no listings for the matter; other firms get their own matches only', async () => {
    const walled = await createStaff({ email: 'walled@roll.example', role: 'attorney' });
    await request(app)
      .post(`/api/cases/${matterId}/exclusions`)
      .set(attorney.auth)
      .send({ userId: walled.id, reason: 'Acts for the other side' })
      .expect(201);
    const seen = await request(app).get('/api/court-rolls/matches?status=all').set(walled.auth);
    expect((seen.body as Array<{ caseId: string }>).some((m) => m.caseId === matterId)).toBe(false);
    const any = (await request(app).get('/api/court-rolls/matches?status=all').set(attorney.auth))
      .body[0];
    expect(
      (await request(app).post(`/api/court-rolls/matches/${any.id}/dismiss`).set(walled.auth))
        .status,
    ).toBe(404);

    // An upload by walled staff doesn't reveal the hidden matter.
    const roll = await pdf(['PRETORIA THIS 3 MARCH 2031', 'IN COURT 4C AT 10:00', '076666/23']);
    const upload = await request(app)
      .post('/api/court-rolls/upload')
      .set(walled.auth)
      .send({
        division: 'ZAGPPHC',
        fileName: 'roll.pdf',
        contentType: 'application/pdf',
        contentBase64: roll.toString('base64'),
      });
    expect(upload.body.matches).toEqual([]);

    // Another firm with the same court case number gets its own match.
    const firm = await createFirm({
      slug: 'roll-other',
      legalName: 'Other',
      domains: ['portal.roll-other.test'],
    });
    const outsider = await createStaff({
      firm,
      host: 'portal.roll-other.test',
      email: 'a@roll-other.example',
      role: 'attorney',
    });
    const theirs = await openMatter(outsider, 'Someone Else', 'portal.roll-other.test');
    await request(app)
      .put(`/api/cases/${theirs.id}/court`)
      .set('Host', 'portal.roll-other.test')
      .set(outsider.auth)
      .send({ courtDivision: 'ZAGPPHC', courtCaseNumber: '10907/2022' })
      .expect(200);
    const site = fakeSite({
      'https://www.court.example/robots.txt': ROBOTS,
      [SOURCE.url]: LISTING,
      [ROLL_URL]: await pdf([...ROLL_LINES, 'IN COURT 9A AT 11:00', '10907/22']),
    });
    await syncCourtRolls({
      sources: [SOURCE],
      fetcher: site.fetcher,
      now: NOW,
      pause: async () => {},
    });
    const outside = await request(app)
      .get('/api/court-rolls/matches?status=all')
      .set('Host', 'portal.roll-other.test')
      .set(outsider.auth);
    expect((outside.body as Array<{ caseId: string }>).map((m) => m.caseId)).toEqual([
      theirs.id,
      theirs.id,
    ]);
    expect(
      (
        await request(app)
          .post(`/api/court-rolls/matches/${any.id}/dismiss`)
          .set('Host', 'portal.roll-other.test')
          .set(outsider.auth)
      ).status,
    ).toBe(404);
    const ours = await inDefaultFirm(() => db().select().from(courtRollMatches));
    expect(ours.every((row) => row.caseId !== theirs.id)).toBe(true);
  });
});
