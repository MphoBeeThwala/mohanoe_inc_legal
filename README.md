# Legal Practice Management Platform

White-label legal practice management software owned by **Ahava on 88 (Pty) Ltd** and licensed to individual law firms on a monthly subscription. Each firm sees its own name, logo and colours; no firm brand is hard-coded.

Current capabilities: encrypted client intake with POPIA consent, de-identified AI triage, case management, documents, billing, calendar, notifications, reports, a tamper-evident audit trail and data-subject compliance tools.

The enterprise roadmap (multi-tenancy, Azure South Africa hosting, grounded AI legal research, time recording, trust accounting) is in [`docs/ROADMAP.md`](docs/ROADMAP.md). Coding conventions for humans and Claude Code are in [`CLAUDE.md`](CLAUDE.md).

## Project layout
An npm workspaces monorepo, all TypeScript (strict):

- `apps/api/` — Express API (`src/`), compiled to `dist/` with `tsc`
  - `src/config/brand.ts` — the single source of firm branding (white-label seam)
  - `src/config/env.ts` — startup checks; production refuses to boot without real secrets
  - `src/lib/http.ts` — `HttpError` and the shared error-response helpers
  - `src/test/` — Vitest unit and HTTP tests (Supertest)
  - `database.sql`, `migrations/` — Postgres schema (to be replaced by one versioned migration history, roadmap epic 3)
- `apps/web/` — React + Vite workspace; loads branding from `GET /api/tenant/branding`
- `packages/shared/` — types shared by the API and the web app (branding, users, API response shapes)
- `scripts/check-legacy-brand.js` — CI guard against hard-coded brand names; `scripts/smoke-test.js` — post-deploy check

## Local development
Requires Node 22+.

1. Copy `.env.example` to `.env` at the repo root. Without Supabase settings the API runs in memory (development only; production refuses to start).
2. `npm install` at the repo root (installs every workspace).
3. `npm run build --workspace packages/shared` once (the API imports the compiled shared types).
4. For the first login, set `ALLOW_PUBLIC_REGISTRATION=true`, then use **Create account** on the sign-in screen. Turn it off afterwards.
5. In two terminals: `npm run dev:api` (port `3001`, reloads on change) and `npm run dev:web` (port `3000`, proxies `/api` to the API).

| Command (repo root) | What it does |
|---|---|
| `npm run typecheck` | Strict TypeScript check of every workspace |
| `npm test` | API and web tests (Vitest) |
| `npm run build` | Builds shared → API (`apps/api/dist`) → web (`apps/web/dist`) |
| `npm start` | Runs the compiled API, which also serves the built web app |
| `npm run format` / `format:check` | Prettier |
| `npm run check:brand` | Brand guard |

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
- Interim hosting is Render (`render.yaml`: `npm ci --include=dev && npm run build`, then `npm start`). The target is Microsoft Azure, South Africa North — see the roadmap.
- After a deploy: `node scripts/smoke-test.js https://<your-host>`.
- If API calls fail with missing tables, see [`SUPABASE_FIX.md`](SUPABASE_FIX.md).
- Backup, restore and smoke tests: [`PROD_OPERATIONS.md`](PROD_OPERATIONS.md).

## Install as a PWA
1. Build (`npm run build`) and serve it over HTTPS.
2. Open the site in Chrome or Edge on desktop or Android.
3. Use **Install app** from the address bar or browser menu.

Offline support covers the app shell only; API calls need a network connection.

## Compliance
- Raw client personal information is encrypted at rest (AES-256-GCM).
- Only de-identified matter summaries are sent to AI.
- Consent is required for storage and AI assessment.
- Data-subject exports and request fulfilment are restricted to admins.

© Ahava on 88 (Pty) Ltd. All rights reserved. Proprietary and confidential.
