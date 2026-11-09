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
  - `src/db/schema.ts` — the database schema (Drizzle ORM); `drizzle/` — generated SQL migrations
  - `src/validation/schemas.ts` — zod schemas for every request body and query
- `apps/web/` — React + Vite workspace; loads branding from `GET /api/tenant/branding`
- `packages/shared/` — types shared by the API and the web app (branding, users, API response shapes)
- `scripts/check-legacy-brand.js` — CI guard against hard-coded brand names; `scripts/smoke-test.js` — post-deploy check

## Local development
Requires Node 22+.

1. Copy `.env.example` to `.env` at the repo root. Leave `DATABASE_URL` empty to use an embedded Postgres (PGlite) stored in `.data/pglite` — no database install needed. Delete that folder to start fresh.
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
| `npm run db:generate -w apps/api` | Generate a migration after changing `src/db/schema.ts` |
| `npm run db:migrate -w apps/api` | Apply migrations (after `npm run build`) |
| `TEST_DATABASE_URL=… npm run test:postgres -w apps/api` | Run the API tests against a disposable real PostgreSQL database |

### Database changes
1. Edit `apps/api/src/db/schema.ts`.
2. `npm run db:generate -w apps/api -- --name short_description` and commit the new file in `apps/api/drizzle/`.
3. Never edit a migration that has been applied anywhere, and never change a shared database by hand.

## Firms (multi-tenancy)
One deployment serves many firms. Every tenant table has a `firm_id`, and PostgreSQL row-level security keeps each firm's rows invisible to the others.

- **Which firm a request belongs to** is decided by the host name: `<slug>.<PLATFORM_BASE_DOMAIN>` first, then a custom domain stored on the firm, then `DEFAULT_FIRM_SLUG`. Unknown hosts get `404 Unknown workspace`; suspended firms get `403`.
- Sessions are bound to their firm: a token issued by one firm is rejected by another.
- **Onboard a firm** (after `npm run build`, with the same `DATABASE_URL` and secrets as the server):

  ```bash
  npm run firm -w apps/api -- create --slug nkosi --name "Nkosi & Partners Inc." --prefix NKP \
    --domain portal.nkosi.co.za --primary-color "#1b7a58" \
    --admin-email admin@nkosi.co.za --admin-name "Thandi Nkosi"
  npm run firm -w apps/api -- list
  ```

  The admin's one-time password is printed once; share it securely.
- The app connects as the database owner but runs every request as the `app_tenant` role (`SET LOCAL ROLE`), which cannot bypass RLS. Migration `0001` creates that role and grants it to the connecting user; see `PROD_OPERATIONS.md` if your server does not allow that.

### Bootstrap branding
When the firms table is empty, the server creates a `default` firm from these variables (existing data is moved into it by the migration). After that, branding is read from the firm row:

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
- Required, or the server will not start: `JWT_SECRET` (32+ chars), `INTAKE_ENCRYPTION_KEY` (32-byte base64 or 64-char hex), `AUDIT_CHAIN_SECRET` (32+ chars), `DATABASE_URL`.
- **Keep `INTAKE_ENCRYPTION_KEY` and `AUDIT_CHAIN_SECRET` safe and unchanged.** Losing the first makes stored client data unreadable; changing the second makes the audit chain fail verification.
- The server applies pending migrations on start (`DB_MIGRATE_ON_START=false` to run `npm run db:migrate -w apps/api` as a separate release step instead).
- `/ready` returns 503 until the database answers.
- `ANTHROPIC_API_KEY` enables live AI triage; without it the backend uses rules-based triage.
- Interim hosting is Render (`render.yaml`: `npm ci --include=dev && npm run build`, then `npm start`). The target is Microsoft Azure, South Africa North — see the roadmap.
- After a deploy: `node scripts/smoke-test.js https://<your-host>`.
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
