import { useEffect, useState } from 'react';
import axios from 'axios';

// White-label branding. The firm's name, logo and colours come from the API,
// never from the code. Until the API answers (or if it fails) a neutral
// default is shown.
export const DEFAULT_BRANDING = Object.freeze({
  firmName: 'Your Firm',
  firmShortName: 'Your Firm',
  productName: 'Legal Practice Workspace',
  logoUrl: null,
  primaryColor: '#1b7a58',
  accentColor: '#0f5d43',
  casePrefix: 'MAT',
  platform: { legalName: 'Ahava on 88 (Pty) Ltd', supportEmail: null },
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function applyBranding(branding, doc = document) {
  const root = doc.documentElement;
  if (HEX_COLOR.test(branding.primaryColor || '')) {
    root.style.setProperty('--brand-green', branding.primaryColor);
  }
  if (HEX_COLOR.test(branding.accentColor || '')) {
    root.style.setProperty('--brand-accent', branding.accentColor);
  }

  doc.title = `${branding.firmName} · ${branding.productName}`;

  const themeColor = doc.querySelector('meta[name="theme-color"]');
  if (themeColor && HEX_COLOR.test(branding.primaryColor || '')) {
    themeColor.setAttribute('content', branding.primaryColor);
  }
}

export function useBranding() {
  const [branding, setBranding] = useState(DEFAULT_BRANDING);

  useEffect(() => {
    let cancelled = false;

    axios
      .get('/api/tenant/branding', { timeout: 10000 })
      .then(({ data }) => {
        if (!cancelled && data && typeof data === 'object') {
          const merged = { ...DEFAULT_BRANDING, ...data };
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
