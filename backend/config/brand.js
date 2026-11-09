// Brand configuration for the white-label platform.
//
// The platform is owned by Ahava on 88 (Pty) Ltd and licensed to individual
// law firms. No firm or product name may be hard-coded anywhere in the app:
// everything a firm's staff or clients see comes from here.
//
// Today the firm brand is read from environment variables (one firm per
// deployment). When multi-tenancy lands (roadmap epic 4) this module becomes
// the fallback and the firm brand is loaded per request from the `firms`
// table, resolved from the request hostname.

const PLATFORM = Object.freeze({
  legalName: 'Ahava on 88 (Pty) Ltd',
  supportEmail: process.env.PLATFORM_SUPPORT_EMAIL || '',
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CASE_PREFIX = /^[A-Z0-9]{2,8}$/;

function readColor(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return HEX_COLOR.test(value) ? value : fallback;
}

function readCasePrefix() {
  const value = String(process.env.FIRM_CASE_PREFIX || '').trim().toUpperCase();
  return CASE_PREFIX.test(value) ? value : 'MAT';
}

function getFirmBrand() {
  const firmName = String(process.env.FIRM_NAME || '').trim();

  return {
    firmName: firmName || 'Your Firm',
    firmShortName: String(process.env.FIRM_SHORT_NAME || '').trim() || firmName || 'Your Firm',
    productName: String(process.env.PRODUCT_NAME || '').trim() || 'Legal Practice Workspace',
    logoUrl: String(process.env.FIRM_LOGO_URL || '').trim() || null,
    primaryColor: readColor('FIRM_PRIMARY_COLOR', '#1b7a58'),
    accentColor: readColor('FIRM_ACCENT_COLOR', '#0f5d43'),
    casePrefix: readCasePrefix(),
  };
}

function getPublicBranding() {
  const brand = getFirmBrand();
  return {
    ...brand,
    platform: {
      legalName: PLATFORM.legalName,
      supportEmail: PLATFORM.supportEmail || null,
    },
  };
}

module.exports = {
  PLATFORM,
  getFirmBrand,
  getPublicBranding,
};
