# Handoff: what is built, what is left, and how to build it

Written 10 Nov 2026, after epic 13. Read this file, `CLAUDE.md` and `docs/ROADMAP.md` before starting.
`CLAUDE.md` holds the rules every change must follow; this file says what to build next and how to work in this repository without breaking them.

## 1. Where things stand

- `main` holds epics 1–13. Every feature PR up to #50 is merged; the only open PR is Dependabot #36 (Node 26, see §6).
- Built: multi-tenant core with forced RLS; identity with MFA; per-firm encryption and records; the practice core (clients, matters, conflicts, FICA, time, billing, calendar, court rolls); white label and onboarding; Azure Terraform and CI/CD; PayFast subscriptions; grounded AI research; trust accounting; the client portal; Court Online; the operators' console; the support desk; and platform tax invoices.
- Tests: 354 API tests and 56 web tests, all passing on PGlite and on PostgreSQL 16.
- GitHub Actions does not run: the GitHub account is billing-locked. Run every check locally before merging (§3).

## 2. Set up

```bash
git clone <this repository's URL> && cd <its folder>   # owner/repo: git remote get-url origin
npm ci
cp .env.example .env          # leave DATABASE_URL empty: embedded PGlite in .data/pglite
npm run dev -w apps/api       # API on :3001 (PORT); see README for the web dev server
```

If start-up says the local database "could not be opened", delete `.data/pglite`. It holds local development data only, and PGlite 0.5 (PostgreSQL 18) cannot open folders made by 0.3.

### Real PostgreSQL for tests (do this for every change touching the database)

PGlite runs as a superuser, so **it ignores row-level security**. A change can pass on PGlite and leak or fail on PostgreSQL. Always also run the suite on PostgreSQL 16:

```bash
# One-off: PostgreSQL 16, and a non-superuser owner role that can create roles
# (the migrations create app_tenant). It must NOT be a superuser or BYPASSRLS,
# or the RLS checks are meaningless.
psql -U postgres -c "create role owner_user login password 'pw' createrole"
# Each run: a fresh database owned by it.
psql -U postgres -c "drop database if exists t" -c "create database t owner owner_user"
TEST_DATABASE_URL=postgresql://owner_user:pw@localhost:55432/t npm run test:postgres -w apps/api
```

## 3. How to work (every task)

1. Branch from up-to-date `main`: `git fetch origin && git checkout -b feat/<name> origin/main`.
2. Read the matching `ROADMAP.md` section and the `CLAUDE.md` rules it touches.
3. Schema changes: edit `apps/api/src/db/schema.ts`, then `npm run db:generate -w apps/api`.
   - Rename the generated migration to something meaningful, and update `drizzle/meta/_journal.json` to match.
   - Append to the migration: `FORCE ROW LEVEL SECURITY` for each new tenant table, plus its `GRANT ... TO app_tenant`.
   - Never edit a migration that is already on `main`.
4. New tables:
   - **Tenant table:** `firmId()` and `tenantPolicy()`. Add `matterPolicy()` if it has a `case_id`.
   - **Platform table:** add it to `PLATFORM_TABLES` in `apps/api/src/test/tenancy.test.ts`. Use `PLATFORM_READ_TABLES` if firms may only read it (SELECT grant only).
5. New encrypted columns: add them to `services/reencrypt.service.ts` (the stale counts, the batch re-encryption and the prune checks) and to `services/firm-export.service.ts`.
6. Every endpoint needs:
   - zod validation (`parse(schema, input)`), `authenticateRequest` and `requirePermission(...)`. Permissions are in `packages/shared/src/index.ts`: `ROLE_PERMISSIONS`.
   - An HTTP test, plus an isolation test showing another firm (a different `Host`) cannot see or change the data.
   - In the web app, controls shown only when `hasPermission(role, ...)` allows them.
7. Before pushing, from the repo root:
   ```bash
   npm run check:brand && npm run format:check && npm run typecheck && npm test && npm run build
   ```
   Then run the PostgreSQL suite (§2). Run `npx prettier --write <files>` after editing.
8. Commit with the trailer the session gives you, push, and open a PR with `gh api repos/<owner>/<repo>/pulls -f base=main -f head=<branch> -f title=... -F body=@file`.
9. Merge once satisfied:
   - Check the branch contains current `main` (`git merge-base --is-ancestor origin/main <branch>`).
   - Merge with `gh api -X PUT .../pulls/<n>/merge -f merge_method=merge -f sha=<head sha>`.
   - Confirm `git diff <branch> origin/main` is empty.
10. Tick the roadmap checklist in the same PR.

### Pitfalls already hit (avoid repeating them)

- **Platform work with `rootDb()` on tenant tables.**
  - The owner role is subject to forced RLS: without `app.firm_id` it sees no rows on PostgreSQL, but sees all of them on PGlite.
  - Either use `withTenant(firm, fn, { system: true })`, or a `rootDb().transaction` that first runs `select set_config('app.firm_id', <id>, true)`, as `platform-invoice.service.ts` does.
  - Add explicit `firm_id` filters as well.
- **Expected database errors inside a transaction** (a test proving a write is refused): run them in a savepoint with `atomically(() => ...)`. Otherwise the transaction is aborted, and PGlite 0.5 throws on commit.
- **Firm rows are cached for 30 s.** Tests that change a `firms` row must call `clearFirmCache()`.
- **Tests:**
  - Signed-in users come from `createStaff()` (`auth` header).
  - Direct service calls go inside `inDefaultFirm()`, never around an HTTP call.
  - Another firm comes from `createFirm({ domains: [host] })` plus `.set('Host', host)`.
  - Console tests set `PLATFORM_CONSOLE_HOST` and send `Host` and `Origin` headers.
- **Web tests:** use Testing Library's `waitFor` and `findBy*`, not `vi.waitFor`, so updates are wrapped in `act`.
- **After `npm install`:** run `npm dedupe`, then check `npm ls react` shows one copy.
- **Audit rows and emails are not encrypted.** Never put names, titles, subjects or message text in them; use numbers.

## 4. Small fixes to do first (one PR, about an hour)

1. `apps/api/src/services/documents.service.ts`, `signDocument()`: the audit summary includes the document title, which can carry client names. That breaks the audit rule in `CLAUDE.md`.
   - Change it to `Document signed` with `details: { documentId }`.
   - Check the other `logEvent` summaries in that file the same way.
   - Add a test that the audit row has no title.
2. Roadmap §10: list epic 13 (done) and point to this file (already done in the PR that added this file).

Done on `fix/audit-free-text`: document, task, timeline, notification and report titles no longer reach audit rows (`test/audit-privacy.test.ts`).

**Next, before pilots: encrypt the MVP's clear-text free-text columns.**

- **Columns:** `case_tasks.title` and `description`, `case_timeline.message`, `documents.title`, `notifications.title` and `body`, `report_snapshots.title`, and `cases.title`. Staff type free text into these, and it can name clients.
- **The usual pattern:**
  - Add `*_encrypted` columns and backfill them with `encryptJson()` in an `ops` command, then drop the clear columns in a later migration.
  - Add the new columns to `reencrypt.service.ts` and `firm-export.service.ts`.
  - Check list views and any search that relied on the clear text.
- **Leave `client_label` alone:** it holds the party number, not a name.

## 5. What is left to build, in order

Each item is one branch and one PR. The acceptance criteria are the minimum; follow `CLAUDE.md` throughout.

### 14. Reporting (P1)

Already exists: `reports.service.ts` (dashboard and saved snapshots) and `billing.service.ts` `agingReport()`.

Build `/api/reports/*` with the `reports.read` permission:

- **Work in progress (WIP):** unbilled time and disbursements per matter and per fee earner, in value and hours.
- **Debtors:** aged 0–30, 31–60, 61–90 and 90+ days by client party number. Reuse `agingReport`.
- **Utilisation:** billable hours ÷ target hours per fee earner per month. Add `users.targetHoursPerMonth`, set by admins.
- **Realisation:** amount billed ÷ value of time recorded, and amount collected ÷ amount billed, per fee earner and per matter.
- **Fee-earner summary:** hours, value, billed and collected for a date range.

How it must behave:

- A date range with South African dates, CSV download for each report, and the web view under Operations → Reports.
- Restricted matters: totals across matters may use `withSystemScope`, but **rows for matters the caller cannot see show "Restricted matter"** (as in the trust `cashbookCsv`).
- Never decrypt client names for reports. Use party and matter numbers.
- Tests: the figures match hand-computed fixtures; a restricted matter is masked; another firm sees nothing; the CSV escapes cells against formula injection (prefix `'` to cells starting with `=`, `+`, `-` or `@`).

### 15. Drafting with firm templates, then e-signature (P1)

**15a: templates and clause bank.**

- Tables: `document_templates` (encrypted body; fields; practice area) and `clauses` (encrypted text; tags). Both are tenant tables.
- Templates use merge fields (`{{client.name}}`, `{{matter.number}}`, `{{firm.legalName}}`, `{{today}}`). They are filled server-side from the matter, with party details decrypted only at render time.
- Output: a DOCX (use the `docx` package) and a PDF (the existing `pdf.service.ts`, or LibreOffice in the image if fidelity matters). Save the result as a matter document through `object-store.ts`.
- Permissions: a new `drafting.manage` for admins and attorneys; templates may be used by anyone with `documents.write`.
- Optional AI assist: only from a **confirmed research brief** and only through `callModel()`. Text sent must be de-identified, and suggestions must cite their sources (`CLAUDE.md` AI rule). The attorney accepts or rejects each one.

**15b: e-signature.**

- The current `signDocument()` only marks a document "signed". Replace that with signing through a provider accredited by the South African Accreditation Authority. ECTA s13 requires an advanced electronic signature where the law asks for a signature.
- Put the provider behind one interface in `lib/esign-client.ts`, like `ai-client.ts`.
- Flow: send the envelope (document plus signers) → webhook (verify its signature) → store the signed PDF and the provider's audit certificate as matter documents → update the status.
- Keep no signer ID numbers in clear text.
- **Decision needed first:** which provider. Ask the user, and get a sandbox account.

### 16. Xero / Sage sync (P1)

- **Scope:** the business (operating) side only. Issued invoices, credit notes (voids) and payments flow to the firm's accounting system. **Never trust ledger entries** (Legal Practice Act s86; the trust ledger stays here).
- Per-firm OAuth connection. Store tokens encrypted with the firm key, add them to `reencrypt.service.ts`, and leave them **out of** the export.
- Account mapping: fees, disbursements, VAT, bank.
- An idempotent push job (an `ops` command plus a scheduled job in `infra/terraform/containerapps.tf`) with a sync log. Retries must never duplicate (use an external id per invoice).
- Contacts go across by client party number plus billing name. Get the firm's consent in the UI, because this sends personal information to the firm's own processor.
- Do Xero first (public API, OAuth 2). Sage Business Cloud Accounting second.
- **Decision needed:** which one pilots use.

### 17. Email filing: Microsoft 365, then Gmail (P1)

- Staff file an email to a matter. M365: a Graph API connection per user, delegated `Mail.Read`, using the firm's existing Entra app registration flow (`config/auth.ts`).
- Store the message (EML) and attachments as encrypted matter documents. Keep only the matter number in audit rows.
- Suggest a matter from the case number or Court Online number in the subject line. Never auto-file.
- An Outlook add-in can come later. Start with an in-app "file recent emails" picker.

### 18. External penetration test (P1, mostly not code)

- Book a CREST-accredited (or equivalent) tester for staging, before GA.
- Scope: tenant isolation, auth and MFA, the portal, the console, PayFast ITN, file upload, SSRF in the court-roll fetchers, and AI prompt injection through intake text.
- Fix the findings in PRs, add a regression test for each, and record the outcome in `docs/runbooks/incident-response.md` or a new `docs/security.md`.

### Smaller follow-ups (from the "Next" notes in `ROADMAP.md`)

- Platform credit notes, to correct or refund a platform invoice (`platform-invoice.service.ts`). Use the same gap-free series, or a separate `CN-` series; the VAT Act s21 says what it must show.
- Client portal: invoice PDFs and PayFast pay-now links for clients (the firm's own merchant account, not the platform's); SMS codes once an SMS provider is chosen.
- Research:
  - Register the licensed sources (`docs/runbooks/research-sources.md`).
  - Replace the synthetic eval set with 50–100 attorney-written cases (`npm run eval`).
  - Pass the confirmed brief into drafting (15a).
- Court Online: turn notification emails into matter events once a pilot shares samples.
- Status page: choose a provider and set `PLATFORM_STATUS_URL`.
- Run the first restore test (`docs/runbooks/restore-test.md`).

### P2 (after GA)

Entra and Google SSO plus SCIM provisioning; a dedicated-instance tier; mobile; a multilingual client portal; data-migration tooling from other practice systems; practice-area modules (conveyancing, litigation bundles, estates); the ISO 27001 / SOC 2 path; a public API with webhooks.

## 6. Node.js runtime

- The app runs Node 22. Node 22 receives security fixes only until **30 April 2027**.
- Node 26 entered LTS on 28 Oct 2026 and is supported to April 2029. Node 24 is supported to April 2028.
- **Plan: move to Node 26 before GA (target January 2027)**, as one PR:
  - `Dockerfile` (both stages), `.github/workflows/ci.yml` `node-version`, `package.json` `engines` (`>=26`).
  - `@types/node` to 26, and remove the `@types/node` ignore rule in `.github/dependabot.yml`.
  - The "Node 22" mentions in `CLAUDE.md` and `README.md`.
- Test: the full suite under Node 26; `docker build`; then a staging deploy, `ops restore-check`, and a smoke test of sign-in, PDFs, PayFast sandbox and research before production.
- Close Dependabot #36 when that PR merges.

## 7. Not code: what the owner must do (blocks go-live)

- **GitHub:** fix the account billing so Actions runs. Turn on Dependabot alerts, Dependabot security updates, and secret scanning with push protection (Settings → Code security).
- **Azure:** paid subscriptions, Foundry quota in Sweden Central, then `terraform apply` (see `docs/runbooks/deployment.md`).
- **PayFast:** a merchant account and a sandbox end-to-end test. Set `platform_invoice_details` (address, registration number, and the VAT number once registered); until VAT-registered, set `platform_vat_rate = 0`.
- **Research sources:** written permission from SAFLII; licences for LexisNexis, Juta and Sabinet if wanted.
- **Legal and POPIA** (`ROADMAP.md` §8): contracts, register the information officer, PAIA manual, and the s72 cross-border basis for AI in Sweden Central.
- **Trust accounting:** an auditor reviews it before any firm uses it live.
- **Pilots:** 1–3 pilot firms, and the product name.
