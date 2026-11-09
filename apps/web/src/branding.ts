import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  DEFAULT_FIRM_BRAND,
  PLATFORM_LEGAL_NAME,
  isHexColor,
  type PublicBranding,
} from '@ahava88/shared';

// White-label branding. The firm's name, logo and colours come from the API,
// never from the code. Until the API answers (or if it fails) a neutral
// default is shown.
export const DEFAULT_BRANDING: PublicBranding = Object.freeze({
  ...DEFAULT_FIRM_BRAND,
  platform: { legalName: PLATFORM_LEGAL_NAME, supportEmail: null },
});

export function applyBranding(branding: PublicBranding, doc: Document = document): void {
  const root = doc.documentElement;
  if (isHexColor(branding.primaryColor)) {
    root.style.setProperty('--brand-green', branding.primaryColor);
  }
  if (isHexColor(branding.accentColor)) {
    root.style.setProperty('--brand-accent', branding.accentColor);
  }

  doc.title = `${branding.firmName} · ${branding.productName}`;

  const themeColor = doc.querySelector('meta[name="theme-color"]');
  if (themeColor && isHexColor(branding.primaryColor)) {
    themeColor.setAttribute('content', branding.primaryColor);
  }
}

export function useBranding(): PublicBranding {
  const [branding, setBranding] = useState<PublicBranding>(DEFAULT_BRANDING);

  useEffect(() => {
    let cancelled = false;

    axios
      .get<Partial<PublicBranding>>('/api/tenant/branding', { timeout: 10000 })
      .then(({ data }) => {
        if (!cancelled && data && typeof data === 'object') {
          const merged: PublicBranding = { ...DEFAULT_BRANDING, ...data };
          setBranding(merged);
          applyBranding(merged);
        }
      })
      .catch(() => {
        if (!cancelled) {
          applyBranding(DEFAULT_BRANDING);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return branding;
}
