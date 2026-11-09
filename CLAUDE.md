# Ahava on 88 — Legal Practice Management (white-label SaaS)

Owner: Ahava on 88 (Pty) Ltd. The product is licensed to individual law firms. The plan and build order live in `docs/ROADMAP.md`; read the relevant section before starting an epic, and tick its checklist when done.

## Non-negotiables
- **No hard-coded brands.** Firm branding comes from `apps/api/src/config/brand.ts` (read from the `firms` row; `FIRM_*` env vars only seed the first firm). `node scripts/check-legacy-brand.js` must pass.
- **Tenant isolation:** every table has `firm_id`; every query runs with `app.firm_id` set; never use a DB role that bypasses RLS; every endpoint gets an isolation test.
- **Every new endpoint:** input validation, `authenticateRequest`, `requirePermission(...)` (permissions per role live in `packages/shared`), tests. In the web app, show a form or action only when `hasPermission(role, …)` allows it (the API still enforces it).
- **Identity:** staff join by invite only; password sign-in always goes through TOTP MFA; sessions are server-side httpOnly cookies. Never add a path that issues a session without MFA (Entra External ID and firms' Microsoft 365 sign-in rely on Entra's MFA). Microsoft 365 sign-in may link an existing account by work address on the firm's own directory and domains, but never creates one. Links in emails use `firmOrigin(firm)`, never the request's Host.
- **Platform support:** operators (`platform_operators`, a platform table with no `app_tenant` access) only enter a firm through an active firm-created support grant, as the read-only `support` role; `checkSupportRequest` audits every request. Never give `support` write permissions or a way around grants.
- **Matter access:** rows that belong to a matter (`case_id`) need a restrictive `matterPolicy()` in the schema (the schema guard in `tenancy.test.ts` checks it). Only `fullFirmScope` / `{ system: true }` lift it, for statutory compliance work and platform jobs.
- **Client personal information** is encrypted before storage with the firm's data key (`await encryptJson()` in `privacy.service.ts`; keys in `keys.service.ts`, wrapped by Key Vault or the local KEK). Look people up by `blindIndex()` / `blindIndexCandidates()`, never by decrypting everything. Never log personal information. New encrypted columns must be added to `reencrypt.service.ts` and `firm-export.service.ts`.
- **Parties:** client and party details live only in `parties.details_encrypted`; search and conflict checks go through `party_index` blind-index hashes (`party-index.ts`). Never store party names in clear columns, case labels or audit rows (use the party number). Conflict checks may look across all matters (`withSystemScope`) but must only name matters the caller can see.
- **FICA:** KYC files and their names are encrypted (`fica.service.ts`); never log or audit file names. Only staff with `fica.verify` mark a client verified, and only with every required document present.
- **Object storage:** document bodies and audit anchors go through `object-store.ts`. Delete objects only in `afterCommit()` (tenant-context), never before the database change commits.
- **AI** only receives de-identified briefs; output must cite retrieved sources (roadmap §7); AI failures surface as errors.
- **Money** is integer cents (ZAR); VAT 15% configurable; invoice numbers sequential and gap-free per firm (taken only when issuing, inside `atomically()`). Invoice subjects, notes and lines are encrypted; issued invoices never change (void instead).
- **Multi-step writes:** a request that answers 4xx still commits. Wrap changes that must happen together in `atomically()` (`db/tenant.ts`), so a failure part-way leaves nothing behind.
- **Calendar:** event titles/locations/notes are encrypted; reminders and audit rows carry only the matter number, type and time. Times are South African (UTC+2); send offsets from the web app.
- **Court rolls:** roll documents/entries are platform tables (no `app_tenant` access) holding case numbers, courtrooms, times and judges only, never party names. Matches go to staff to confirm; a roll never changes the calendar by itself. Fetch politely (`court-roll-sources.ts`).
- **White label:** firm-visible names, colours, logo, prefixes and domains come from the `firms` row and `firm_assets`; never hard-code them. A custom domain is used (email links, `firmOrigin`) only once `white-label.service` has verified its TXT record and HTTPS routing. No SVG uploads.
- **Time** is whole 6-minute units with the rate fixed when recorded (`time.service.ts`); narratives are encrypted; billed or written-off time never changes.
- **Production fails fast:** `apps/api/src/config/env.ts` refuses to boot without real secrets. Don't add silent fallbacks that run in production.
- **Infrastructure** lives in `infra/terraform` (format with `terraform fmt`); a new env var for production goes in `containerapps.tf` (`app_env`, or a Key Vault secret for secrets). A new scheduled task is an `ops` command plus a scheduled job there. Errors sent to Sentry go through `lib/monitoring.ts`, which strips personal information.
- Schema changes: edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w apps/api`; commit the migration. Never edit an applied migration; no manual SQL in production.
- Audit: use `auditService.logEvent` (or `logEventSafely` for best-effort events). Never put personal information in audit summaries/details: audit rows are not encrypted.

## Stack
- npm workspaces: `apps/api` (Express 5, Node 22, strict TypeScript compiled to CommonJS), `apps/web` (React 18 + Vite, strict TypeScript), `packages/shared` (shared types — put API request/response shapes here).
- Data: Drizzle ORM over PostgreSQL (`DATABASE_URL`); PGlite (embedded Postgres) in development and tests. Call `db()` for tenant queries: it returns the request's tenant transaction (running as `app_tenant` with `app.firm_id` set) and throws outside `withTenant()`. `rootDb()` is only for platform work (firms, migrations, the tenant middleware). New tenant tables need `firmId()` and `tenantPolicy()` in the schema, and the migration must FORCE RLS and grant `app_tenant` access (the schema guard in `tenancy.test.ts` enforces this). Rows are typed from the schema. Use `nextValue()` for human-readable numbers. Money is integer cents (`lib/money.ts`).
- Input: services take `unknown` and `parse(schema, input)` with zod schemas from `validation/schemas.ts`.
- Tests: Vitest everywhere; every API test file gets a fresh migrated PGlite database (`src/test/setup.ts`). HTTP tests use Supertest against the real app; direct service/database calls go inside `inDefaultFirm()` (`src/test/helpers.ts`, full matter visibility), never around an HTTP call. Use `createStaff()` for signed-in users (invite → password → MFA over HTTP). `npm run test:postgres -w apps/api` with `TEST_DATABASE_URL` runs them on real PostgreSQL.
- Errors: throw `httpError(message, status)`; controllers answer with `sendError(res, error)`.
- Target infra: Azure South Africa North (DR: South Africa West) via Terraform — Container Apps, PostgreSQL Flexible Server, Blob Storage, Key Vault, Service Bus, Entra External ID, Front Door. Claude via Microsoft Foundry (Sweden Central) behind one AI client interface.

## Workflow
- One epic per branch, one PR per task; branch from up-to-date `main`.
- Before pushing (repo root): `npm run check:brand && npm run format:check && npm run typecheck && npm test && npm run build`.
- Keep secrets out of the repo; use `.env.example` for new variables and document them in `README.md`.
