// Branding for the white-label platform.
//
// The platform is owned by Ahava on 88 (Pty) Ltd and licensed to individual
// law firms. No firm or product name may be hard-coded anywhere in the app:
// a firm's name, logo, colours and case prefix come from its row in the
// `firms` table. The FIRM_* environment variables are only used to create
// the default firm on a fresh single-firm installation.

import {
  DEFAULT_FIRM_BRAND,
  PLATFORM_LEGAL_NAME,
  isHexColor,
  type FirmBrand,
  type PublicBranding,
} from '@ahava88/shared';
import type { FirmRow } from '../db/schema';

const CASE_PREFIX = /^[A-Z0-9]{2,8}$/;

function platformInfo() {
  return {
    legalName: PLATFORM_LEGAL_NAME,
    supportEmail: process.env.PLATFORM_SUPPORT_EMAIL || null,
  };
}

function readColor(name: string, fallback: string): string {
  const value = String(process.env[name] || '').trim();
  return isHexColor(value) ? value : fallback;
}

function readCasePrefix(): string {
  const value = String(process.env.FIRM_CASE_PREFIX || '')
    .trim()
    .toUpperCase();
  return CASE_PREFIX.test(value) ? value : DEFAULT_FIRM_BRAND.casePrefix;
}

/** The default firm's brand, from FIRM_* env vars (first-run bootstrap only). */
export function envFirmDefaults(): FirmBrand {
  const firmName = String(process.env.FIRM_NAME || '').trim();

  return {
    firmName: firmName || DEFAULT_FIRM_BRAND.firmName,
    firmShortName:
      String(process.env.FIRM_SHORT_NAME || '').trim() || firmName || DEFAULT_FIRM_BRAND.firmName,
    productName: String(process.env.PRODUCT_NAME || '').trim() || DEFAULT_FIRM_BRAND.productName,
    logoUrl: String(process.env.FIRM_LOGO_URL || '').trim() || null,
    primaryColor: readColor('FIRM_PRIMARY_COLOR', DEFAULT_FIRM_BRAND.primaryColor),
    accentColor: readColor('FIRM_ACCENT_COLOR', DEFAULT_FIRM_BRAND.accentColor),
    casePrefix: readCasePrefix(),
  };
}

/** A firm's brand, with safe platform defaults for anything unset. */
export function getFirmBrand(firm: FirmRow): FirmBrand {
  const branding = firm.branding ?? {};
  return {
    firmName: firm.legalName,
    firmShortName: firm.tradingName || firm.legalName,
    productName: firm.productName || DEFAULT_FIRM_BRAND.productName,
    // Uploaded assets are served by the API (versioned so caches refresh).
    logoUrl: branding.logoHash
      ? `/api/tenant/logo?v=${branding.logoHash}`
      : branding.logoUrl || null,
    iconUrl: branding.iconHash
      ? `/api/tenant/icon?v=${branding.iconHash}`
      : branding.logoHash
        ? `/api/tenant/logo?v=${branding.logoHash}`
        : null,
    primaryColor: isHexColor(branding.primaryColor)
      ? branding.primaryColor
      : DEFAULT_FIRM_BRAND.primaryColor,
    accentColor: isHexColor(branding.accentColor)
      ? branding.accentColor
      : DEFAULT_FIRM_BRAND.accentColor,
    casePrefix: CASE_PREFIX.test(firm.casePrefix) ? firm.casePrefix : DEFAULT_FIRM_BRAND.casePrefix,
  };
}

export function getPublicBranding(firm: FirmRow): PublicBranding {
  return { ...getFirmBrand(firm), platform: platformInfo() };
}
