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
- **Microsoft 365 sign-in per firm** (Entra ID). The platform registers one multi-tenant app (`ENTRA_WORKFORCE_CLIENT_ID`, `ENTRA_WORKFORCE_CLIENT_SECRET`). A firm's administrators enter their directory (tenant) ID and work email domains under **Account & team → Microsoft 365**, and their Microsoft 365 admin approves the app with the link shown there.
  - Tokens must come from that directory, and guests are refused.
  - Existing staff are linked on their first Microsoft sign-in by their work address (UPN) on a listed domain. New people still need an invite: no account is ever created by signing in.
  - Firms can **require** Microsoft sign-in. Then only administrators can still use password + authenticator, as a break-glass route.
- **Lockout:** 5 failed attempts lock an account for 15 minutes (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`). A password reset lifts the lock.
- **Sessions** are server-side, in httpOnly `SameSite=Lax` cookies (`__Host-` and `Secure` in production). They end after `SESSION_IDLE_MINUTES` idle or `SESSION_MAX_HOURS`, and are revoked by sign-out, password change or reset, MFA reset and deactivation. Cookie-authenticated writes must come from the workspace's own origin (CSRF protection). API clients can send the session token as a bearer token.
- **Roles** (per firm): Administrator, Attorney, Paralegal, Secretary, Bookkeeper. Each grants permissions (`ROLE_PERMISSIONS` in `packages/shared`); routes check them with `requirePermission(...)`. Role changes apply on the next request.
- **Matter access:** a matter is visible firm-wide by default. Its lead (whoever opened it) or an administrator can restrict it to named members, and add **ethical walls** that hide it from specific people, administrators included. PostgreSQL row-level security enforces this, and hides the matter's tasks, documents, invoices, ledger, calendar and intake record with it. POPIA exports, erasure and retention sweeps (information officer only) still cover every matter.

## Platform support access
- Ahava on 88 support staff (*platform operators*) have no standing access to any firm. Create them with `npm run ops -w apps/api -- operator create --email … --name …`; it prints a one-time password and an authenticator key, and MFA is mandatory. List or disable them with `operator list`, `operator disable --email …`.
- A firm administrator opens access under **Account & team → Support access**, for 1 hour to 3 days and with a reason. While a grant is active, the operator signs in at that firm's address under `/support` (email, password, authenticator code).
- Support sessions are **read-only** (role `support`). Restricted matters and ethical walls still apply, and the session ends when the grant expires or is revoked. **Every request** is written to the firm's audit trail, with the method and path.

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
- **AI** goes through one client (`apps/api/src/lib/ai-client.ts`):
  - **Providers.** `AI_PROVIDER=foundry` (Claude in Microsoft Foundry at `AI_ENDPOINT`, keyless via the managed identity or with `AI_API_KEY`) or `anthropic` (development). `AI_MODEL` / `AI_RESEARCH_MODEL` name the model or deployment.
  - **No AI.** Without a provider, intakes open as "not assessed".
  - **Failures.** A failed AI call is an error the user can retry; there is no rules-based fallback.
  - **Logging and limits.** Every call is logged per firm (tokens, encrypted de-identified prompt and answer) and capped by `AI_FIRM_MONTHLY_TOKENS`. Administrators see usage at `GET /api/ai/usage`.
  - **De-identification.** Everything sent is de-identified first (`services/deidentify.ts`); research briefs are previewed, edited and confirmed by the attorney.
  - **Research.** Answers come only from approved sources (`ops sources …`, see [`docs/runbooks/research-sources.md`](docs/runbooks/research-sources.md)), ranked by the hierarchy of authority, with repealed law excluded. Every claim must cite a retrieved passage, and code removes any that don't. An attorney (`research.approve`) approves the memo, which is kept with its sources.
  - **Legislation feed.** `LAWS_AFRICA_TOKEN` enables the weekly Laws.Africa sync.
  - **Evaluation.** `npm run eval -w apps/api` runs the evaluation set before model or prompt changes.
- Interim hosting is Render (`render.yaml`: `npm ci --include=dev && npm run build`, then `npm start`).
- **Azure** (South Africa North, DR South Africa West): Terraform in `infra/terraform`, the container image from `Dockerfile`, GitHub Actions for CI (`ci.yml`, including an image smoke test and `terraform validate`), infrastructure (`infra.yml`) and releases (`deploy.yml`). See [`docs/runbooks/deployment.md`](docs/runbooks/deployment.md).
- **Subscriptions**: firms pay through PayFast recurring billing (`PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_SANDBOX`; trial, grace and VAT settings `SUBSCRIPTION_TRIAL_DAYS`, `SUBSCRIPTION_TRIAL_SEATS`, `SUBSCRIPTION_GRACE_DAYS`, `PLATFORM_VAT_RATE`). Plans: `npm run ops -w apps/api -- plans set …`; daily notices and read-only mode: `ops subscriptions`. See [`docs/runbooks/subscriptions.md`](docs/runbooks/subscriptions.md).
- Monitoring: `SENTRY_DSN` (optional) sends 5xx errors to Sentry with personal information removed; `APP_RELEASE` and `DEPLOY_ENVIRONMENT` tag them. Behind Azure Front Door set `FRONT_DOOR_ID` (requests without its `X-Azure-FDID` header get 403) and `TRUST_PROXY_HOPS` (2 behind Front Door and Container Apps; default 1).
- After a deploy: `node scripts/smoke-test.js https://<your-host>`.
- Backup, restore and smoke tests: [`PROD_OPERATIONS.md`](PROD_OPERATIONS.md).

## Clients and conflict checks
- **Party register:** clients, opposing parties, their attorneys and related persons are *parties*. Their details (name, ID or registration number, contacts) are encrypted with the firm's key. Blind-index hashes let staff search by any name word, ID/registration number, email or phone without decrypting the register.
- **Conflict checks** (**Clients → New client**, or **New matter for this client**) search the whole register for the prospective client and the other parties:
  - A *strong* match is the same ID/registration number, email, phone or full name; a *possible* match shares name words.
  - Checks look across restricted and walled matters too, but only name the matters the person checking can see, and count the rest.
  - Every check and its decision (clear, conflict, or waived by an administrator with notes) is kept as the firm's conflict register.
- **Opening clients and matters:** a client, and every matter (`POST /api/cases`), needs a check that was cleared or waived within the last 90 days. Adding an existing client as an opposing party is refused without a recorded waiver.
- **Matter references:** matters opened for a client have a title and carry the client's party number (never a name) in `clientLabel`. Intake-based matters still work as before.

## FICA (customer due diligence)
- **Profile:** each client has a FICA profile (Clients → select a client). Risk factors (politically exposed, high-risk jurisdiction, not met face to face, cash-intensive, complex ownership) give the rating. Staff may raise it but never lower it below what the factors give.
- **Documents:** KYC documents (PDF, JPEG or PNG, up to 10 MB, checked against their content) are encrypted with the firm's key, file names included, and stored in the firm's container when `OBJECT_STORE` is set. Opening one is audited.
- **Required documents:**
  - individuals: ID document and proof of address
  - organisations: CIPC registration, directors' IDs, beneficial ownership and proof of address
  - high risk adds source of funds
- **Verification** (fee earners; secretaries collect documents but can't verify) needs every required document. It sets the next review: 12, 24 or 36 months for high, medium or low risk. Raising the risk, or removing a required document, reopens verification.
- **Firm switch:** administrators can require verified FICA before any new matter (Account & team → Records). Overdue reviews then block new matters too.

## Time recording
- **Units:** time is recorded in 6-minute units (0.1 h), rounded up. A fee earner can't record more than 24 hours on one day, across all matters, or time for a future date. Closed matters take no new time.
- **Recording:** use **Time** to record time manually (minutes, activity, billable or not, narrative), or start a timer on a matter, pause and resume it, and stop it to record the time. Each person has one timer, which survives sign-out.
- **Rates:** administrators set each fee earner's standard hourly rate, plus agreed rates on a matter for one fee earner or for everyone on it (`PUT /api/time/matters/:caseId/rates`). The order of precedence is the fee earner's matter rate, then the matter rate, then the standard rate. An entry keeps the rate it was recorded at. Billable time needs a rate.
- **Work in progress:** unbilled billable time, by matter and by fee earner (fee earners, bookkeepers and administrators).
- **Changes:** people change or delete their own unbilled time. Administrators can also change other people's time and write it off. Billed and written-off time doesn't change.
- **Encryption and audit:** narratives can name people, so they are encrypted with the firm's key. Audit rows record only hours and amounts.

## Billing
- **Firm details first:** administrators enter the firm's invoice details under Operations → Billing → Invoice details: VAT vendor or not, VAT number, address, business bank account, payment terms and footer. Invoices can't be issued without an address, and a VAT vendor also needs its VAT number.
- **Disbursements** (sheriff, counsel, deeds office and similar) are recorded on a matter at cost, with or without VAT.
- **Invoices:**
  - **Draft:** a draft for a matter takes its unbilled billable time and disbursements, plus any manual lines. The draft holds them, so other drafts can't take them and the time can't change until the draft is issued or deleted.
  - **Issue:** issuing gives the next number (`INV-000001`, per firm). The number is taken in the same database transaction, so numbers are sequential with no gaps. Issuing also sets the due date and marks the time and disbursements billed.
  - **Void:** an administrator can void an unpaid invoice. It keeps its number and its time returns to work in progress.
- **VAT:** VAT (`VAT_RATE`, default 15%) applies to fees and to vatable disbursements. A VAT vendor's PDF is headed *Tax invoice* and shows the details the VAT Act requires.
- **Payments:** payments (EFT, card, cash, transfer from trust, other) can be part or full, and can't exceed what is owing. Administrators can reverse a payment recorded in error.
- **Documents and email:** invoices and client statements are branded PDFs. **Email** sends the invoice PDF to the client's address (`SMTP_URL` must be set).
- **Statements and aging:** a client statement has a running balance and aging (current, 30, 60, 90 and 120+ days past due). The aging report covers all outstanding invoices, by client.
- **Encryption:** subjects, notes and line descriptions can name people, so they are encrypted with the firm's key. Amounts, numbers and dates stay readable for reports.
- **Not covered:** trust accounting under the Legal Practice Act (section 86) is not built yet. The trust/operating ledger is a simple record.

## White label and onboarding
- **Onboarding wizard:** a new firm's administrator is taken through five steps after first sign-in: practice details, name/logo/colours, invoicing and VAT, numbering and compliance, and inviting the team. Steps can be skipped, and everything can be changed later under **Account & team → Firm settings**.
- **Practice details:** the firm's address, registration, Legal Practice Council and Fidelity Fund certificate numbers, and contact details are printed in the letterhead of invoices and statements.
- **Brand:**
  - The registered and trading names, main and accent colours, and the matter and invoice number prefixes are set in the app.
  - Colours must contrast at least 4.5:1 with the white text placed on them (WCAG AA).
  - The logo (PNG, JPEG or WebP, up to 1 MB) and an optional browser icon are stored with the firm and served before sign-in at `/api/tenant/logo` and `/api/tenant/icon`, with versioned links. SVG is refused because it can carry script. The logo also goes on PDFs.
- **Email:** the platform sends from `MAIL_FROM`, in the firm's trading name, with replies going to the firm's reply-to address.
- **Custom domains:** a firm adds its own address (e.g. `portal.firm.co.za`) and publishes two DNS records: a TXT record proving ownership, and a CNAME to `CUSTOM_DOMAIN_CNAME_TARGET` (the Front Door endpoint, which also issues the certificate). **Check now** (or the hourly `npm run ops -w apps/api -- domains` job) verifies the TXT record, then that `https://<domain>/.well-known/firm-domain-check` answers with a value only this platform can produce. Only then does the domain become the firm's main address, used in email links.

## Calendar and prescription
- **Events:** court dates, deadlines, meetings and consultations are recorded on a matter, with an optional assignee, and appear in Operations → Calendar as a 90-day agenda. Times are South African time. Events can be marked done or cancelled. **Download for Outlook (.ics)** exports the agenda for Outlook or Google Calendar.
- **Court details:** each matter records its court (High Court division, Labour Court, magistrate's court or other) and the court's case number. Numbers are normalised (`34660/16`, `034660/2016` and `2016-034660` are the same case) so court rolls can be matched.
- **Prescription:** each matter can record limitation periods:
  - Prescription Act s11 periods: 3, 6, 15 and 30 years.
  - Notice to an organ of state: 6 months (Act 40 of 2002, s3(2)(a)).
  - RAF claims: 3 years where the driver or owner is identified, 2 years for hit-and-run.
  - Any other period, entered with its last day.

  The last day is the day before the anniversary, and it goes on the calendar with reminders 90, 30 and 7 days and a day before. The attorney confirms the period and when it started to run; delays and interruptions are entered by changing the dates or marking the period interrupted or closed. This is a reminder, not legal advice.
- **Reminders:** reminders go out by email and in the app, to the event's assignee or else the matter's team. They show the matter number, event type and time, not the title. Run `npm run ops -w apps/api -- reminders` every 15 minutes as a scheduled job (an Azure Container Apps job), or set `CALENDAR_REMINDER_INTERVAL_MINUTES`. Reminders more than six hours late, after downtime, are skipped.
- **Encryption:** event titles, locations and notes, and prescription notes, are encrypted with the firm's key.

## Court rolls
- **Schedule and sources:** published court rolls are fetched on a schedule and matched with matters by court and court case number, which are set on each matter.
  - Run `npm run ops -w apps/api -- court-rolls` as a scheduled job. Twice a week is the default (Mon and Thu 06:00 SAST: cron `0 4 * * 1,4`).
  - The listing pages are configured in `COURT_ROLL_SOURCES`, for example a division's court-rolls page on the judiciary website, with a filter such as `Pretoria`.
- **Matches need a person:** each match goes to the matter's team, by email and in the app. It appears under Operations → Calendar → Court rolls, where staff **Add to calendar** or **Dismiss** it. A roll never changes the calendar by itself: rolls are amended, and a published roll doesn't show matters that were removed, postponed or settled.
- **Amended rolls:** an amended roll supersedes the earlier one (the same link with new content, or the same court, date and title marked "amended"). A matter that drops off it is flagged *removed* and its team is told; its calendar entry stays until someone checks with the registrar.
- **Politeness:** the sync identifies itself (`COURT_ROLL_USER_AGENT`), honours `robots.txt`, waits two seconds between requests, fetches only https, and caps size (15 MB) and time (30 s). An unchanged roll is not read again.
- **No party names:** rolls are public, but only case numbers, courtrooms, times, judges and roll sections are stored. The roll documents and their entries are platform tables that firms' requests cannot read; each firm sees only its own matches.
- **Uploads:** staff can upload a roll they received another way, for example by email from a registrar, as PDF, Word (.docx), HTML or text. It is matched only with matters the uploader can see, and is not stored. A platform operator can import one for every firm with `ops court-rolls --file roll.pdf --division ZAGPPHC --title "…"`.
- **Official sources:** check the court websites' terms before turning the sync on. Prefer official feeds (CaseLines, Court Online) when they become available to the platform.

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
