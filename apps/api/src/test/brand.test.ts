import { test } from 'vitest';
import * as brandModule from '../config/brand';
import assert from 'node:assert/strict';

const KEYS = [
  'FIRM_NAME',
  'FIRM_SHORT_NAME',
  'PRODUCT_NAME',
  'FIRM_LOGO_URL',
  'FIRM_PRIMARY_COLOR',
  'FIRM_ACCENT_COLOR',
  'FIRM_CASE_PREFIX',
];

function withEnv(values: Record<string, string>, fn: (brand: typeof brandModule) => void): void {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, values);
  try {
    fn(brandModule);
  } finally {
    KEYS.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

test('neutral defaults when no firm is configured', () => {
  withEnv({}, ({ envFirmDefaults }) => {
    const brand = envFirmDefaults();
    assert.equal(brand.firmName, 'Your Firm');
    assert.equal(brand.casePrefix, 'MAT');
    assert.equal(brand.logoUrl, null);
  });
});

test('the default firm is seeded from FIRM_* configuration', () => {
  withEnv(
    {
      FIRM_NAME: 'Nkosi & Partners Inc.',
      FIRM_SHORT_NAME: 'Nkosi',
      FIRM_PRIMARY_COLOR: '#123456',
      FIRM_CASE_PREFIX: 'nkp',
    },
    ({ envFirmDefaults }) => {
      const brand = envFirmDefaults();
      assert.equal(brand.firmName, 'Nkosi & Partners Inc.');
      assert.equal(brand.firmShortName, 'Nkosi');
      assert.equal(brand.primaryColor, '#123456');
      assert.equal(brand.casePrefix, 'NKP');
    },
  );
});

test('invalid colours and prefixes fall back to safe defaults', () => {
  withEnv(
    { FIRM_PRIMARY_COLOR: 'red; background:url(x)', FIRM_CASE_PREFIX: 'BAD PREFIX!' },
    ({ envFirmDefaults }) => {
      const brand = envFirmDefaults();
      assert.equal(brand.primaryColor, '#1b7a58');
      assert.equal(brand.casePrefix, 'MAT');
    },
  );
});

test('a firm row drives its public branding, with safe fallbacks', () => {
  const firm = {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'nkosi',
    legalName: 'Nkosi & Partners Inc.',
    tradingName: 'Nkosi',
    productName: null,
    branding: { primaryColor: '#123456', accentColor: 'url(javascript:alert(1))' },
    casePrefix: 'NKP',
    domains: [],
    vatNumber: null,
    plan: 'pilot',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const brand = brandModule.getPublicBranding(firm);
  assert.equal(brand.firmName, 'Nkosi & Partners Inc.');
  assert.equal(brand.firmShortName, 'Nkosi');
  assert.equal(brand.primaryColor, '#123456');
  assert.equal(brand.accentColor, '#0f5d43');
  assert.equal(brand.casePrefix, 'NKP');
  assert.equal(brand.productName, 'Legal Practice Workspace');
  assert.equal(brand.platform.legalName, 'Ahava on 88 (Pty) Ltd');
});
