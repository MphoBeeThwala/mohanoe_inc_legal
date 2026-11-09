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
4. Create your first administrator: `npm run build -w apps/api && npm run firm -w apps/api -- invite --slug default --email you@example.com --name "Your Name"`, then open the printed link (set `APP_ORIGIN=http://localhost:3000` so it points at the dev web server). You'll choose a password and connect an authenticator app.
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

## Staff accounts and sign-in
- **Invite only.** There is no public registration. Administrators invite staff under **Account & team**; the firm's first administrator is invited with the CLI (`npm run firm -w apps/api -- create … --admin-email …` or `… invite --slug … --email …`). Invite and reset links are emailed when `SMTP_URL` is set, and are always shown once to whoever created them.
- **Two-factor sign-in is mandatory** for password accounts: after the password, an authenticator-app code (TOTP) or a one-time recovery code. New accounts set up the authenticator before their first session. Codes can't be replayed.
- **Microsoft Entra External ID** sign-in is enabled with `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Enforce MFA in Entra (user flow / Conditional Access); `OIDC_REQUIRE_MFA_CLAIM=true` also checks the token. An Entra identity is linked to an account only by accepting an invite with it — emails are never used to match accounts. Register `https://<firm address>/api/auth/oidc/callback` as a redirect URI for every firm.
- **Lockout:** 5 failed attempts lock an account for 15 minutes (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`). A password reset lifts the lock.
- **Sessions** are server-side, in httpOnly `SameSite=Lax` cookies (`__Host-` and `Secure` in production). They end after `SESSION_IDLE_MINUTES` idle or `SESSION_MAX_HOURS`, and are revoked by sign-out, password change or reset, MFA reset and deactivation. Cookie-authenticated writes must come from the workspace's own origin (CSRF protection). API clients can send the session token as a bearer token.
- **Roles** (per firm): Administrator, Attorney, Paralegal, Secretary, Bookkeeper. Each grants permissions (`ROLE_PERMISSIONS` in `packages/shared`); routes check them with `requirePermission(...)`. Role changes apply on the next request.
- **Matter access:** a matter is visible firm-wide by default. Its lead (whoever opened it) or an administrator can restrict it to named members, and add **ethical walls** that hide it from specific people, administrators included. PostgreSQL row-level security enforces this, and hides the matter's tasks, documents, invoices, ledger, calendar and intake record with it. POPIA exports, erasure and retention sweeps (information officer only) still cover every matter.

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

  The admin's invitation link is printed once (and emailed when `SMTP_URL` is set); share it securely. To invite another administrator later: `npm run firm -w apps/api -- invite --slug nkosi --email it@nkosi.co.za --name "IT Admin"`.
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
- **Keep `INTAKE_ENCRYPTION_KEY` and `AUDIT_CHAIN_SECRET` safe.** With `KEY_PROVIDER=local` the first wraps every firm's keys: losing it makes stored client data unreadable. Changing the second makes the audit chain fail verification. See *Encryption and records* for rotating keys.
- The server applies pending migrations on start (`DB_MIGRATE_ON_START=false` to run `npm run db:migrate -w apps/api` as a separate release step instead).
- `/ready` returns 503 until the database answers.
- `ANTHROPIC_API_KEY` enables live AI triage; without it the backend uses rules-based triage.
- Interim hosting is Render (`render.yaml`: `npm ci --include=dev && npm run build`, then `npm start`). The target is Microsoft Azure, South Africa North — see the roadmap.
- After a deploy: `node scripts/smoke-test.js https://<your-host>`.
- Backup, restore and smoke tests: [`PROD_OPERATIONS.md`](PROD_OPERATIONS.md).

## Encryption and records
- **Per-firm envelope encryption.** Each firm has its own random data key (and a separate blind-index key), stored only wrapped by a key-encryption key: Azure Key Vault in production (`KEY_PROVIDER=azure-keyvault`, `AZURE_KEY_VAULT_KEY_ID`, managed identity), or `INTAKE_ENCRYPTION_KEY` locally. Ciphertext (`v2:`) is bound to its firm, so it can't be decrypted in another firm's rows. Data written before this (`v1:`) still reads; move it with `keys reencrypt`.
- **Key operations** (`npm run ops -w apps/api -- …`, same environment as the server):
  - `keys status` — keys per firm and how much data is not yet on the active key
  - `keys rotate --slug <firm>` then `keys reencrypt --slug <firm>` then `keys prune` — rotate a firm's data key
  - `keys rewrap` — after rotating the Key Vault key or `INTAKE_ENCRYPTION_KEY` (set `INTAKE_ENCRYPTION_KEY_PREVIOUS`), or moving from local to Key Vault
  - `anchor` — anchor every firm's audit chain (run daily)
- **Documents** go to `OBJECT_STORE` (`azure-blob` in production, one container per firm, encrypted before upload). Unset, they stay encrypted in PostgreSQL. Deleting a matter removes its blobs only after the database change commits.
- **Audit anchors**: the head of each firm's chain is recorded daily, with a write-once copy in an immutable container. Administrators use **Verify audit trail** (Account & team), which checks the chain and every anchor, so rewriting history is detected even by someone holding `AUDIT_CHAIN_SECRET`.
- **POPIA requests** (data-subject access, export, erasure) are for administrators (the information officer).
- **Retention**: administrators set their firm's retention period (at least a year); `CLIENT_DATA_RETENTION_DAYS` is the default.
- **Firm exit**: `npm run firm -w apps/api -- export --slug <firm> --out <file>` writes all of a firm's data, decrypted, without credentials or keys.

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
