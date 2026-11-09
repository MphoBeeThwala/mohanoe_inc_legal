// White label and onboarding: firm details, brand, logo and icon, custom
// domains, email sender, onboarding progress, permissions and isolation.
import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import app from '../server';
import { createFirm, firmOrigin, findFirmBySlug } from '../services/firm.service';
import { testOutbox } from '../services/mail.service';
import { formatInvoiceNumber } from '../services/billing.service';
import {
  checkDomain,
  domainCheckValue,
  imageType,
  txtRecordName,
  type DomainChecks,
} from '../services/white-label.service';
import { createStaff, defaultFirm, inDefaultFirm, type TestStaff } from './helpers';

let admin: TestStaff;
let attorney: TestStaff;

/** A PNG header with the given size (enough for type and size checks). */
function png(width = 200, height = 60, extra = 64): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([header, ihdr, Buffer.alloc(extra, 7)]);
}

const settings = (staff: TestStaff, body: object) =>
  request(app).patch('/api/firm/settings').set(staff.auth).send(body);

beforeAll(async () => {
  admin = await createStaff({ email: 'admin@wl.example', role: 'admin', fullName: 'Ada Admin' });
  attorney = await createStaff({ email: 'attorney@wl.example', role: 'attorney' });
});

describe('firm details and brand', () => {
  test('administrators set practice details, names, colours and numbering', async () => {
    const res = await settings(admin, {
      profile: {
        registrationNumber: '2015/123456/21',
        lpcNumber: 'F12345',
        fidelityFundCertificate: '2026/0042',
        email: 'Info@Nkosi.example',
        phone: '+27 31 555 0100',
        website: 'https://nkosi.example',
        replyToEmail: 'accounts@nkosi.example',
      },
      brand: {
        legalName: 'Nkosi and Partners Incorporated',
        tradingName: 'Nkosi Attorneys',
        primaryColor: '#1f4e79',
        accentColor: '#7a4b00',
        casePrefix: 'nka',
      },
      billing: { invoicePrefix: 'nk' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.profile).toMatchObject({ email: 'info@nkosi.example', lpcNumber: 'F12345' });
    expect(res.body.brand).toMatchObject({
      legalName: 'Nkosi and Partners Incorporated',
      tradingName: 'Nkosi Attorneys',
      primaryColor: '#1f4e79',
      casePrefix: 'NKA',
      logoUrl: null,
    });
    expect(res.body.billing.invoicePrefix).toBe('NK');
    expect(formatInvoiceNumber(5, 'NK')).toBe('NK-000005');

    const branding = await request(app).get('/api/tenant/branding');
    expect(branding.body).toMatchObject({
      firmName: 'Nkosi and Partners Incorporated',
      firmShortName: 'Nkosi Attorneys',
      primaryColor: '#1f4e79',
      casePrefix: 'NKA',
    });
  });

  test('colours too light for white text, bad values and non-administrators are refused', async () => {
    const light = await settings(admin, { brand: { primaryColor: '#ffeb3b' } });
    expect(light.status).toBe(400);
    expect(light.body.message).toContain('too light');
    expect((await settings(admin, { brand: { casePrefix: 'x' } })).status).toBe(400);
    expect(
      (await settings(admin, { profile: { website: 'http://insecure.example' } })).status,
    ).toBe(400);
    expect((await settings(admin, { billing: { invoicePrefix: 'INVOICE1' } })).status).toBe(400);
    expect((await settings(attorney, { brand: { tradingName: 'Mine' } })).status).toBe(403);
  });

  test("email goes out in the firm's name, with replies to its address", async () => {
    await createStaff({ email: 'newcomer@wl.example', role: 'secretary' });
    const invite = await request(app)
      .post('/api/users/invites')
      .set(admin.auth)
      .send({ email: 'another@wl.example', fullName: 'Another', role: 'secretary' });
    expect(invite.status, JSON.stringify(invite.body)).toBeLessThan(300);
    const message = testOutbox().find((mail) => mail.to === 'another@wl.example');
    expect(message?.from).toMatch(/^"Nkosi Attorneys" </);
    expect(message?.replyTo).toBe('accounts@nkosi.example');
  });
});

describe('logo and icon', () => {
  test('a PNG logo is stored and served before sign-in, versioned', async () => {
    const logo = png();
    const res = await request(app)
      .put('/api/firm/assets/logo')
      .set(admin.auth)
      .send({ contentType: 'image/png', contentBase64: logo.toString('base64') });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.url).toMatch(/^\/api\/tenant\/logo\?v=[0-9a-f]{16}$/);

    const branding = (await request(app).get('/api/tenant/branding')).body;
    expect(branding.logoUrl).toBe(res.body.url);
    expect(branding.iconUrl).toBe(res.body.url); // no icon yet: the logo

    const served = await request(app).get(res.body.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare(served.body as Buffer, logo)).toBe(0);
    expect((await request(app).get('/api/tenant/icon')).status).toBe(200);
  });

  test('SVG, mislabelled, oversized and huge images are refused', async () => {
    const put = (kind: string, body: Buffer) =>
      request(app)
        .put(`/api/firm/assets/${kind}`)
        .set(admin.auth)
        .send({ contentType: 'image/png', contentBase64: body.toString('base64') });
    expect((await put('logo', Buffer.from('<svg onload="alert(1)"/>'))).status).toBe(400);
    expect((await put('logo', Buffer.from('GIF89a....'))).status).toBe(400);
    expect((await put('icon', png(64, 64, 300 * 1024))).status).toBe(400);
    expect((await put('logo', png(9000, 100))).status).toBe(400);
    expect((await put('banner', png())).status).toBe(404);
    expect(
      (
        await request(app)
          .put('/api/firm/assets/logo')
          .set(attorney.auth)
          .send({ contentType: 'image/png', contentBase64: png().toString('base64') })
      ).status,
    ).toBe(403);
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  test('a separate icon, and removing assets', async () => {
    const icon = png(64, 64);
    const res = await request(app)
      .put('/api/firm/assets/icon')
      .set(admin.auth)
      .send({ contentType: 'image/png', contentBase64: icon.toString('base64') });
    expect((await request(app).get('/api/tenant/branding')).body.iconUrl).toBe(res.body.url);
    await request(app).delete('/api/firm/assets/logo').set(admin.auth).expect(200);
    expect((await request(app).get('/api/tenant/logo')).status).toBe(404);
    expect((await request(app).get('/api/tenant/branding')).body.logoUrl).toBeNull();
    expect((await request(app).get('/api/tenant/icon')).status).toBe(200);
  });
});

describe('custom domains', () => {
  const checks = (txt: string[][], answer: string | Error): DomainChecks => ({
    resolveTxt: async () => txt,
    fetchCheck: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });

  test('a domain is active only after its TXT record and HTTPS both check out', async () => {
    const added = await request(app)
      .post('/api/firm/domains')
      .set(admin.auth)
      .send({ domain: 'https://Portal.Nkosi.example/login' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({
      domain: 'portal.nkosi.example',
      status: 'pending_dns',
      txtRecordName: txtRecordName('portal.nkosi.example'),
    });
    expect(added.body.txtRecordValue).toMatch(/^firm-domain-verification=/);
    expect(
      (
        await request(app)
          .post('/api/firm/domains')
          .set(admin.auth)
          .send({ domain: 'portal.nkosi.example' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post('/api/firm/domains')
          .set(admin.auth)
          .send({ domain: 'not a domain' })
      ).status,
    ).toBe(400);

    const id = added.body.id as string;
    const record = [[added.body.txtRecordValue as string]];
    const noTxt = await inDefaultFirm(() => checkDomain(id, {}, checks([], 'x')));
    expect(noTxt).toMatchObject({ status: 'pending_dns' });
    expect(noTxt.lastError).toContain('TXT record');
    const unrouted = await inDefaultFirm(() =>
      checkDomain(id, {}, checks(record, new Error('ECONNREFUSED'))),
    );
    expect(unrouted).toMatchObject({ status: 'pending_routing' });
    const elsewhere = await inDefaultFirm(() =>
      checkDomain(id, {}, checks(record, 'someone else')),
    );
    expect(elsewhere.lastError).toContain('not from this platform');
    // Not active yet: links still use the platform address.
    expect(firmOrigin((await defaultFirm())!)).not.toContain('portal.nkosi.example');

    const active = await inDefaultFirm(() =>
      checkDomain(id, {}, checks(record, domainCheckValue('portal.nkosi.example'))),
    );
    expect(active).toMatchObject({ status: 'active', lastError: null });
    const firm = (await findFirmBySlug('default'))!;
    expect(firm.domains[0]).toBe('portal.nkosi.example');
    expect(firmOrigin(firm)).toBe('https://portal.nkosi.example');

    // Requests to the domain now reach this firm.
    const viaDomain = await request(app)
      .get('/api/tenant/branding')
      .set('Host', 'portal.nkosi.example');
    expect(viaDomain.body.firmShortName).toBe('Nkosi Attorneys');
  });

  test('only this platform answers the domain check', async () => {
    const res = await request(app)
      .get('/.well-known/firm-domain-check')
      .set('Host', 'portal.nkosi.example');
    expect(res.text).toBe(domainCheckValue('portal.nkosi.example'));
    expect(res.text).not.toBe(domainCheckValue('other.example'));
  });

  test("another firm can't claim, see or change the domain", async () => {
    const other = await createFirm({
      slug: 'wl-other',
      legalName: 'Other Firm',
      domains: ['portal.wl-other.test'],
    });
    const outsider = await createStaff({
      firm: other,
      host: 'portal.wl-other.test',
      email: 'a@wl-other.example',
      role: 'admin',
    });
    const as = (r: request.Test) => r.set('Host', 'portal.wl-other.test').set(outsider.auth);
    expect(
      (await as(request(app).post('/api/firm/domains')).send({ domain: 'portal.nkosi.example' }))
        .status,
    ).toBe(409);
    expect((await as(request(app).get('/api/firm/domains'))).body).toEqual([]);
    const [ours] = (await request(app).get('/api/firm/domains').set(admin.auth)).body;
    expect((await as(request(app).post(`/api/firm/domains/${ours.id}/check`))).status).toBe(404);
    expect((await as(request(app).delete(`/api/firm/domains/${ours.id}`))).status).toBe(404);
    // Its own branding and assets, not ours.
    expect(
      (await request(app).get('/api/tenant/icon').set('Host', 'portal.wl-other.test')).status,
    ).toBe(404);
    expect(
      (
        await as(request(app).patch('/api/firm/settings')).send({
          brand: { tradingName: 'Theirs' },
        })
      ).status,
    ).toBe(200);
    expect((await request(app).get('/api/tenant/branding')).body.firmShortName).toBe(
      'Nkosi Attorneys',
    );
  });

  test('removing an active domain stops it resolving to the firm', async () => {
    const [ours] = (await request(app).get('/api/firm/domains').set(admin.auth)).body;
    await request(app).delete(`/api/firm/domains/${ours.id}`).set(admin.auth).expect(200);
    expect((await findFirmBySlug('default'))!.domains).not.toContain('portal.nkosi.example');
  });
});

describe('onboarding', () => {
  test('steps are ticked off and the wizard finished by an administrator', async () => {
    const start = await request(app).get('/api/firm/onboarding').set(admin.auth);
    expect(start.body).toMatchObject({ complete: false, completedAt: null });
    expect(start.body.steps.map((step: { id: string }) => step.id)).toEqual([
      'profile',
      'brand',
      'billing',
      'practice',
      'team',
    ]);
    const step = await request(app)
      .patch('/api/firm/onboarding')
      .set(admin.auth)
      .send({ done: 'profile' });
    expect(step.body.steps[0]).toMatchObject({ id: 'profile', done: true });
    expect(
      (await request(app).patch('/api/firm/onboarding').set(admin.auth).send({ done: 'nope' }))
        .status,
    ).toBe(400);
    expect(
      (await request(app).patch('/api/firm/onboarding').set(attorney.auth).send({ finish: true }))
        .status,
    ).toBe(403);
    const finished = await request(app)
      .patch('/api/firm/onboarding')
      .set(admin.auth)
      .send({ finish: true });
    expect(finished.body.complete).toBe(true);
    expect(finished.body.completedAt).toBeTruthy();
  });
});
