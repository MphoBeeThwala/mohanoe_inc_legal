# Legal Practice Management Platform

White-label legal practice management software owned by **Ahava on 88 (Pty) Ltd** and licensed to individual law firms on a monthly subscription. Each firm sees its own name, logo and colours; no firm brand is hard-coded.

Current capabilities: encrypted client intake with POPIA consent, de-identified AI triage, case management, documents, billing, calendar, notifications, reports, a tamper-evident audit trail and data-subject compliance tools.

The enterprise roadmap (multi-tenancy, Azure South Africa hosting, grounded AI legal research, time recording, trust accounting) is in [`docs/ROADMAP.md`](docs/ROADMAP.md). Coding conventions for humans and Claude Code are in [`CLAUDE.md`](CLAUDE.md).

## Project layout
- `backend/` — Express API, intake workflow, encryption, AI assessment
- `backend/config/brand.js` — the single source of firm branding (white-label seam)
- `backend/config/env.js` — startup checks; production refuses to boot without real secrets
- `backend/test/` — unit tests (`npm test` in `backend/`)
- `frontend/` — React workspace; loads branding from `GET /api/tenant/branding`
- `backend/database.sql`, `backend/migrations/` — Postgres schema (to be replaced by one versioned migration history, roadmap epic 3)
- `scripts/check-legacy-brand.js` — CI guard against hard-coded brand names

## Local development
1. Copy `.env.example` to `.env` and fill in what you need. Without Supabase settings the API runs in memory (development only; production refuses to start).
2. `npm ci` in `backend/` and in `frontend/`.
3. For the first login, set `ALLOW_PUBLIC_REGISTRATION=true`, start the backend, then use **Create account** on the sign-in screen. Turn it off afterwards.
4. Backend: `npm start` in `backend/` (port `3001`). Frontend: `npm start` in `frontend/` (port `3000`).
5. Tests: `npm test` in `backend/`, and `node scripts/check-legacy-brand.js` from the repo root.

## Branding a deployment (one firm per deployment, until multi-tenancy)
Set these environment variables; anything missing falls back to a neutral default:

| Variable | Example | Used for |
|---|---|---|
| `FIRM_NAME` | `Nkosi & Partners Inc.` | Header, page title |
| `FIRM_SHORT_NAME` | `Nkosi` | Brand mark initial |
| `FIRM_LOGO_URL` | `https://…/logo.png` | Logo in place of the initial |
| `FIRM_PRIMARY_COLOR` / `FIRM_ACCENT_COLOR` | `#1b7a58` / `#0f5d43` | Theme colours (6-digit hex only) |
| `FIRM_CASE_PREFIX` | `NKP` | Case numbers, e.g. `NKP-2026-0001` (2–8 letters/digits) |
| `PRODUCT_NAME` | `Legal Practice Workspace` | Product name in the page title |
| `PLATFORM_SUPPORT_EMAIL` | `support@…` | Platform support contact |

## Production
- Required, or the server will not start: `JWT_SECRET` (32+ chars), `INTAKE_ENCRYPTION_KEY` (32-byte base64 or 64-char hex), `AUDIT_CHAIN_SECRET` (32+ chars), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- `ANTHROPIC_API_KEY` enables live AI triage; without it the backend uses rules-based triage.
- Interim hosting is Render (`render.yaml`). The target is Microsoft Azure, South Africa North — see the roadmap.
- If API calls fail with missing tables, see [`SUPABASE_FIX.md`](SUPABASE_FIX.md).
- Backup, restore and smoke tests: [`PROD_OPERATIONS.md`](PROD_OPERATIONS.md).

## Install as a PWA
1. Build the frontend (`npm run build --prefix frontend`) and serve it over HTTPS.
2. Open the site in Chrome or Edge on desktop or Android.
3. Use **Install app** from the address bar or browser menu.

Offline support covers the app shell only; API calls need a network connection.

## Compliance
- Raw client personal information is encrypted at rest (AES-256-GCM).
- Only de-identified matter summaries are sent to AI.
- Consent is required for storage and AI assessment.
- Data-subject exports and request fulfilment are restricted to admins.

© Ahava on 88 (Pty) Ltd. All rights reserved. Proprietary and confidential.
