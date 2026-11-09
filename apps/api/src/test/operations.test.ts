// Production operations: the Front Door guard, error responses and
// monitoring scrubbing, and the restore check.
import { afterEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import type { Response } from 'express';
import app from '../server';
import { sendError, httpError } from '../lib/http';
import { scrub } from '../lib/monitoring';
import { restoreCheck } from '../services/restore-check.service';
import { createStaff } from './helpers';

afterEach(() => {
  delete process.env.FRONT_DOOR_ID;
  vi.unstubAllEnvs();
});

describe('Front Door guard', () => {
  test('only requests through our Front Door profile are served; probes stay open', async () => {
    process.env.FRONT_DOOR_ID = '6f2c0d4e-1b7a-4f8e-9c3d-2a5b6c7d8e9f';
    expect((await request(app).get('/api/tenant/branding')).status).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/tenant/branding')
          .set('X-Azure-FDID', '00000000-0000-0000-0000-000000000000')
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/tenant/branding')
          .set('X-Azure-FDID', '6F2C0D4E-1B7A-4F8E-9C3D-2A5B6C7D8E9F')
      ).status,
    ).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
    expect([200, 503]).toContain((await request(app).get('/ready')).status);
  });

  test('off when FRONT_DOOR_ID is unset', async () => {
    expect((await request(app).get('/api/tenant/branding')).status).toBe(200);
  });
});

describe('errors', () => {
  function fakeResponse() {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      req: { requestId: 'req-1', originalUrl: '/api/x?email=a@b.example' },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    return res;
  }

  test('in production, unexpected errors are hidden behind a request ID', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeResponse();
    sendError(res as unknown as Response, new Error('relation "secret_table" does not exist'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      message: 'Something went wrong. Please try again.',
      requestId: 'req-1',
    });
    // The log keeps the detail, without the query string.
    expect(spy.mock.calls[0]![0]).toContain('secret_table');
    expect(spy.mock.calls[0]![0]).not.toContain('a@b.example');
    spy.mockRestore();

    const client = fakeResponse();
    sendError(client as unknown as Response, httpError('Matter not found', 404));
    expect(client.body).toEqual({ message: 'Matter not found' });
  });

  test('monitoring scrubs things that look like personal information', () => {
    expect(scrub('Failed for thandi@example.co.za, ID 8001015009087, account 62012345678')).toBe(
      'Failed for [email], ID [id-number], account [number]',
    );
  });
});

describe('restore check', () => {
  test('a healthy database passes: migrations, audit chain, decryption', async () => {
    await createStaff({ email: 'admin@restore.example', role: 'admin' });
    const report = await restoreCheck();
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.migrations.applied).toBe(report.migrations.expected);
    expect(report.firms[0]).toMatchObject({ firm: 'default', auditTrustworthy: true });
    expect(report.firms[0]!.counts.auditEvents).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain('restore.example');
  });
});
