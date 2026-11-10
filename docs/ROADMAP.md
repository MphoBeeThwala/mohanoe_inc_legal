# Enterprise Readiness Plan & Architecture

Owner: Ahava on 88 (Pty) Ltd · Plan dated 9 Nov 2026
Live, editable version: "Ahava on 88 Legal PMS — Enterprise Readiness Plan & Architecture" (Claude Docs). This file is the repo copy that Claude Code and developers build from; update both when decisions change.

## 1. Summary

The codebase is a solid **single-firm MVP** with good privacy foundations: encrypted intake, redaction before AI calls, consent gates and a hash-chained audit log. It is **not yet multi-tenant SaaS**. Enterprise level needs five shifts:

1. **One platform, many firms.** Every record belongs to a firm (tenant), enforced by the database.
2. **White-label by configuration.** No brand in code; each firm's name, logo, colours, domain and templates come from settings.
3. **Client data at rest in South Africa.**
4. **Grounded AI.** Legal research answers only from licensed, citable sources, always with attorney sign-off.
5. **Run it like a software business.** Subscriptions, onboarding, support, SLAs, contracts and POPIA paperwork.

**Decisions**

- **Hosting:** Microsoft Azure, South Africa North (Johannesburg), with South Africa West (Cape Town) for in-country disaster recovery. Decided 9 Nov 2026.
- **Stack:** Node.js + React, moving to TypeScript; PostgreSQL with row-level security; managed identity.
- **Tenancy:** pooled database with strict row-level isolation by default, plus a dedicated-instance tier for large firms. One codebase.
- **Go-to-market:** pilot with 1–3 firms before general availability (GA).
- **Timeline:** ~5–7 weeks to a hardened pilot; ~12–14 weeks to GA with grounded AI research, trust accounting and an external penetration test.

## 2. Rebrand and white-label model

Ahava on 88 (Pty) Ltd owns the software and IP and licenses it to firms monthly. The retired working title is removed everywhere; `scripts/check-legacy-brand.js` enforces this in CI.

| Layer | Controls | Shows in |
|---|---|---|
| **Platform: Ahava on 88** | Legal entity, support email, status page, super-admin console, optional "Powered by" footer | Terms, invoices to firms, admin tools |
| **Firm (tenant)** | Name, logo, colours, favicon, custom domain, email sender, invoice letterhead, VAT number, practice/Fidelity Fund certificate details, case and invoice prefixes, document templates | Everything firm staff and clients see |

Technical design:
- A `firms` table: `slug`, `legal_name`, `trading_name`, `branding` (logo, primary/accent colours), `domains[]`, `case_prefix`, `invoice_settings`, `vat_number`, `plan`, `status`.
- Before login the frontend calls `GET /api/tenant/branding` (resolves the firm from the hostname) and applies colours as CSS variables. **Done: read from the `firms` table (epic 4); env vars only seed the first firm.**
- Default domain `firmslug.<product-domain>`; custom domains via Azure Front Door managed certificates.
- Emails, PDFs and the client portal render from firm branding.

Open decision: a product name separate from the company name.

## 3. Architecture review

**Keep:** one API + one web app (modular monolith); PostgreSQL (relational, RLS, pgvector); the privacy pattern (encrypt raw data, de-identify before AI, consent, tamper-evident audit).

| Area | Today | Recommended |
|---|---|---|
| Language | Plain JavaScript | Strict TypeScript |
| API | Express 5, duplicated try/catch, no validation | zod schemas on every route, central error handler, OpenAPI |
| Data access | Supabase client with service-role key (bypasses RLS), whole-table reads, in-memory fallback | Drizzle on Postgres, versioned migrations, per-request `SET app.firm_id`, paginated indexed queries, no memory mode |
| Tenancy | None | `firm_id` everywhere, RLS policies, `(firm_id, …)` indexes, tenant resolver, isolation tests |
| Authentication | Home-built scrypt + JWT in `localStorage` | Microsoft Entra External ID (+ Entra ID sign-in for Microsoft 365 firms), httpOnly cookies, mandatory MFA |
| Authorisation | 3 global roles | Per-firm roles, matter-level access, ethical walls |
| Encryption | One env key for everything | Azure Key Vault envelope encryption, a data key per firm, key versioning, rotation |
| Documents | Encrypted JSON in a DB column; "sign" flips a status | Blob Storage (Key Vault keys, container per firm, versioning, SAS links, Defender malware scan); real e-signature provider |
| Background work | AI calls inside the request | Service Bus (or `pg-boss`) + worker |
| AI | One prompt, no retrieval, silent fallback | Retrieval-grounded research with citation checks (section 7) |
| Frontend | Create React App, very large components | Vite + React + TS, routes, TanStack Query, component library, CSS-variable theming |
| Audit | One global chain | Per-firm chain, daily anchors to immutable Blob Storage |
| Rate limiting | In memory | Front Door WAF rules + Redis for login |
| Testing/CI | Minimal | Unit/API tests, Playwright E2E, mandatory tenant-isolation tests, GitHub Actions |
| Observability | `console.log` | pino → Azure Monitor/App Insights, Sentry, alerts |

Target architecture:

```
Firm staff / clients (firm.<product-domain> or custom domain)
        │
  Azure Front Door + WAF ── React app (Static Web Apps / Blob)
        │
  Azure Container Apps: API (2+ replicas across zones)
        │                    │                   │
  PostgreSQL Flexible   Blob Storage        Service Bus ── Worker containers
  Server (zone-HA,      (documents,              ├─ Claude via Microsoft Foundry (Sweden Central, private endpoint)
  pgvector, RLS)        immutable audit)         ├─ Azure Communication Services (email)
        │                                        └─ PDFs, reminders
  Key Vault · Entra External ID · Azure Monitor / App Insights
  PayFast ITN → subscriptions
  Region: South Africa North · Backups/DR: South Africa West
```

Tenancy tiers: **pooled** (default, shared DB + RLS) and **dedicated** (separate DB or stack, premium), same pipeline.

## 4. Deployment and data residency (Azure)

**Why Azure:** client data at rest stays in South Africa (Supabase removed its SA region); South Africa North (3 availability zones) pairs with South Africa West for in-country DR; most SA firms run Microsoft 365; PostgreSQL Flexible Server with pgvector is available in South Africa North.

**Where the AI runs (disclose to firms):** Claude on Azure is deployed via Microsoft Foundry, whose project must be in a supported region (East US 2 or Sweden Central) — use **Sweden Central**. Inference therefore happens outside SA; acceptable because only de-identified briefs are sent. Put it in the operator agreement, document the POPIA s72 basis, list Anthropic as a sub-processor (Foundry customers are subject to Anthropic's data use terms). Fallback: the Anthropic API directly, behind the same AI client interface.

| Need | Azure service |
|---|---|
| API and workers | Container Apps (2+ replicas, zone-redundant) |
| Database | PostgreSQL Flexible Server, zone-redundant HA |
| Documents, audit anchors | Blob Storage (versioning, immutability, Defender for Storage) |
| Keys and secrets | Key Vault (HSM-backed keys in prod) |
| Login, MFA, SSO | Entra External ID + Entra ID |
| Queue | Service Bus (or `pg-boss` for the pilot) |
| CDN, custom-domain TLS, WAF | Front Door Premium + WAF |
| Email | Azure Communication Services Email |
| Monitoring | Azure Monitor, Log Analytics, App Insights, Sentry |
| Claude | Microsoft Foundry (Sweden Central) via private endpoint |
| Networking | VNet with private endpoints for DB, storage, Key Vault |

Environment setup:
- Separate `dev`/`staging`/`prod` subscriptions under one management group, with budgets. **Paid** subscription (free/credit-only can't deploy Claude); request Foundry quota early.
- Terraform (or Bicep); GitHub Actions with OIDC federated credentials; PR → tests → staging → approval → prod.
- Backups/DR: PostgreSQL PITR + geo-backup to South Africa West, geo-redundant storage, Key Vault soft-delete + purge protection, quarterly restore test. Confirm South Africa West access early.
- SLA targets: 99.5% pilot / 99.9% GA uptime, RPO ≤ 15 min, RTO ≤ 4 h.
- Cost: Azure Pricing Calculator; start on Burstable PostgreSQL + consumption Container Apps.

## 5. P0 backlog (before any firm pays)

### 5.1 Rebrand and clean-up — epic 1
- [x] Remove the retired working-title brand and old case prefix; CI guard against reappearance
- [x] Delete dead code (Mongoose, `config/db.js`, client model/service/routes, root HTML prototypes, unused React components)
- [x] `npm audit` clean on the backend
- [x] Production refuses to start without real secrets; timing-safe password check; seed-admin and data-subject export/fulfilment restricted to admins
- [x] TypeScript monorepo (`apps/api`, `apps/web`, `packages/shared`), Vite instead of CRA — epic 2
- [ ] Dependabot and secret scanning enabled in GitHub settings

### 5.2 Multi-tenancy and data layer
- [x] `firms` table; `firm_id NOT NULL` on all tables; backfill to the first firm
- [x] RLS on every table keyed on `current_setting('app.firm_id')`; app role cannot bypass
- [x] Tenant resolver (hostname → firm); every query in a transaction that sets the firm
- [x] One versioned migration history (Drizzle) replacing the hand-run SQL files
- [x] Remove all in-memory fallbacks; zod request validation (config validated by `config/env.ts`)
- [x] Indexes and bounded queries; no whole-table reads (cursor pagination for large lists still to do)
- [x] Per-firm sequences for case, client and invoice numbers (gap-free invoices): per-firm atomic counters; invoice numbers are taken when issuing, in the same transaction
- [x] Isolation tests across every endpoint (`tenancy.test.ts`, plus a schema guard that fails if a table lacks `firm_id` or RLS)

### 5.3 Identity and access
- [x] Entra External ID, mandatory staff MFA, reset, lockout, revocation
- [x] httpOnly secure SameSite cookies
- [x] Invite-only users per firm; remove public registration and `/auth/seed-admin`
- [x] Per-firm roles, matter-level access, ethical walls (enforced by RLS)
- [x] Platform super-admin with audited, firm-approved support access (support grants; read-only; every request audited)
- [x] CSP, HSTS, helmet-style headers

### 5.4 Encryption and records
- [x] Key Vault envelope encryption per firm + re-encryption migration + rotation
- [x] Per-firm audit chain anchored daily to immutable storage; "verify audit trail" for admins
- [x] Documents in Blob Storage (encrypted per firm before upload; uploads of files arrive with the practice core)
- [x] Data-subject requests restricted to firm admins / information officer
- [x] Per-firm retention and full firm data export on exit

### 5.5 Core practice features
- [x] Clients (individuals and entities) and matters, with conflict-of-interest checks (encrypted party register, blind-index search, conflict register with decisions and waivers)
- [x] FICA onboarding (KYC documents, risk rating, verification status, review dates, optional enforcement before new matters)
- [x] Time recording: timer, manual entries, 6-minute units, fee-earner and matter rates, billable/non-billable, WIP
- [x] Billing from time + disbursements, 15% VAT, branded PDFs, email, payments, statements, aging
- [x] Calendar: court dates, deadlines, prescription reminders, email notifications
- [x] Court roll sync (brought forward from P1): published rolls fetched twice a week and matched by court case number for staff to confirm; amended rolls flag removed matters; roll upload. Next: CaseLines / Court Online integration.
- [x] Intake → consent → de-identified triage → matter (`deidentify.ts`, no rules fallback)

### 5.6 SaaS operations
- [x] Firm onboarding wizard (practice details, brand, invoicing, numbering, team); firm settings, uploaded logo and icon, colour contrast check, custom domains verified by DNS and HTTPS, emails in the firm's name
- [x] ZAR subscriptions via PayFast (plans, seats, trial, dunning, read-only suspension): `subscription.service.ts`, `payfast.ts`, Account → Subscription, `ops plans` / `ops subscriptions`. Next: PayFast merchant account approval and a sandbox end-to-end test; platform tax invoices to firms.
- [x] AI usage metering (`ai_calls`, per-firm monthly cap, `GET /api/ai/usage`)
- [x] IaC, staging/prod, CI/CD, tested restores, Sentry, uptime alerts (`infra/terraform`, GitHub Actions, `ops restore-check`, `docs/runbooks`). Next: choose and set up the hosted status page; run the first restore test.
- [ ] Support desk, help centre (incident runbook done: `docs/runbooks/incident-response.md`)

## 6. P1 (by GA) and P2 (after GA)

**P1:** trust accounting (Legal Practice Act s86, built with an auditor reviewing); court roll management (explore CaseLines and Court Online); grounded AI research v1; drafting with firm templates and clause bank; e-signature via an accredited provider where ECTA requires an advanced signature; client portal; reporting (WIP, debtors, utilisation, realisation); Xero/Sage sync; Microsoft 365/Gmail email filing; external pen test.

**P2:** Entra/Google SSO + SCIM; dedicated-instance tier; mobile; multilingual client portal; data-migration tooling; practice-area modules (conveyancing, litigation bundles, estates); ISO 27001/SOC 2 path; public API and webhooks.

## 7. AI research guardrails

Principles: attorney-facing only; no final opinion without attorney sign-off; answer only from retrieved sources; cite every proposition; say "no authority found" rather than guess.

Pipeline:
1. Structured intake (facts, parties, dates, jurisdiction, desired outcome), encrypted.
2. De-identification: intake-listed parties → role tokens (`[Client]`, `[Respondent]`, `[Child 1]`); pattern rules (SA IDs incl. spaced, phones, emails, addresses, bank accounts, case numbers); NER for unlisted names/places; mapping stays server-side; attorney previews and can edit the exact brief before sending.
3. Query planning from the redacted brief.
4. Retrieval from an approved corpus only: official legislation; SAFLII case law **only with written permission or licence** (no scraping); Juta/LexisNexis only under licence; journals whose licences allow it; the firm's private precedents.
5. Constrained generation citing retrieved chunk IDs.
6. Citation verification in code; unsupported claims removed or flagged.
7. Attorney review and approval; approved memo stored with a source snapshot.

Controls: 50–100-matter evaluation set run before any model/prompt change; AI failures surface as failures (no silent rules fallback); model IDs in config; one AI client interface (Foundry or Anthropic API); redacted prompt/response logging per firm; confirm no-training terms; per-firm usage caps.

## 8. Legal, POPIA and commercial readiness

*To be reviewed by a South African technology/privacy attorney; not legal advice.*

- Company/IP: written IP assignment to Ahava on 88 from every developer and contractor, plus written confirmation that no party connected to the retired working title claims the code; trade mark for the product name; PI and cyber insurance.
- Contracts: Master Subscription Agreement; SLA; operator agreement (POPIA s21); AI terms (decision support, attorney responsible); acceptable use; public sub-processor list (Microsoft Azure, Anthropic via Foundry, email, payments, error monitoring).
- POPIA programme: information officer registered; PAIA manual; record of processing and data-flow map; s72 basis for cross-border processing; s22 breach plan; security policies.
- Profession: confidentiality/privilege controls, LPC record-keeping and trust rules, FICA records.
- Plans (validate with pilots): Starter, Practice, Enterprise; per-user monthly pricing, annual discount, onboarding/migration fee, metered AI credits.

## 9. Phased roadmap

| Phase | Dates | Scope | Exit criteria |
|---|---|---|---|
| 0 Foundations | 9–13 Nov | Rebrand and clean-up; paid Azure subscriptions + Foundry quota; confirm South Africa West; contracts with an attorney; 1–3 pilot firms; ask SAFLII | No retired brand anywhere; repo renamed; pilots committed |
| 1 Platform core | to ~4 Dec | TS monorepo, data layer, multi-tenancy + RLS, Entra External ID + MFA, Key Vault encryption, Blob documents, staging IaC | Isolation tests pass; staging on Azure South Africa North |
| 2 Pilot-ready | to ~24 Dec | Clients/matters, conflicts, FICA, time, invoicing, calendar, onboarding, white-label settings, prod, restore test, monitoring | First pilot live; restore test passed |
| 3 Pilot + hardening | Jan 2027 | Feedback fixes, subscriptions, super-admin, support desk, pen test booked | Daily use; paying |
| 4 GA | Feb 2027 | Grounded AI v1, trust accounting, court roll, client portal, pen-test fixes, contract templates | Pen test clean; eval set passing; launch |

Trust accounting and AI research ship behind feature flags to pilots first.

## 10. Build order (one branch and PR per epic)

1. **Rebrand and clean-up** — done on `chore/rebrand-ahava88-cleanup`.
2. **TypeScript monorepo** — done on `chore/typescript-monorepo-vite`.
3. **Data layer** — done on `feat/data-layer-drizzle`: Drizzle + PostgreSQL, one migration history, PGlite for dev/tests, zod validation, linked audit chain, race-free numbering, money in cents, email blind index.
4. **Multi-tenancy** — done on `feat/multi-tenancy`: `firms` table, `firm_id` and forced RLS on every table, `app_tenant` role, host-name resolver, per-firm numbering and audit chains, firm CLI, isolation tests; branding from `firms`.
5. **Identity** — done on `feat/identity` (except super-admin): invite-only staff, mandatory TOTP MFA with recovery codes, Entra External ID (OIDC + PKCE), lockout, resets, revocable server-side cookie sessions, CSRF origin check, five roles with permissions, matter access and ethical walls in RLS, CSP/HSTS. Platform support access, per-firm Microsoft 365 (Entra ID) sign-in and permission-aware screens (read-only roles see no edit forms) followed in their own PRs.
6. **Encryption and records** — done on `feat/encryption-records`: per-firm data and index keys wrapped by Azure Key Vault (or a local KEK), rotation, re-encryption and rewrap via `npm run ops`, documents in Blob Storage, daily audit anchors with immutable copies and anchor-aware verification, admin-only POPIA requests, per-firm retention, firm exit export.
7. **Practice core** — clients/matters, conflicts, FICA, time, invoicing, calendar.
8. **White-label and onboarding** — done on `feat/white-label-onboarding`: firm settings, theming, logo and icon, custom domains (DNS + HTTPS verification), emails in the firm's name, onboarding wizard.
9. **Infrastructure** — done on `feat/infrastructure`: Terraform for staging/prod in South Africa North (private VNet, PostgreSQL HA + geo-backups, RA-GZRS storage, HSM Key Vault, Container Apps + scheduled jobs, Front Door Premium + WAF, ACS Email), DR to South Africa West, CI/CD with OIDC and approval, Sentry with PII scrubbing, alerts and budgets, restore check and runbooks.
10. **Subscriptions** — done on `feat/subscriptions` with PayFast recurring billing (checkout, verified ITNs, seat changes and cancelling through the PayFast API, trial → past due → read-only).
11. **AI research** — in progress on `feat/ai-research`:
    - 11a, done: one AI client (Foundry / Anthropic), de-identification, metering and caps, and attorney-confirmed research briefs.
    - 11b, done:
      - Corpus: an approved-source register with licences, a hierarchy of authority, and validity tracking (repealed provisions excluded).
      - Sources: a Laws.Africa adapter, file imports, and firm precedents with review.
      - Answering: query planning, then authority-weighted full-text retrieval, then cited generation, then citation checks in code (`research-run.ts`).
      - Sign-off and testing: attorney approval with a source snapshot, and the evaluation harness (`npm run eval`).
    - Next:
      - Register the sources whose licences are in place (`docs/runbooks/research-sources.md`).
      - Replace the synthetic evaluation set with 50–100 attorney-written cases.
      - Use the confirmed brief in drafting.
12. **Trust accounting, court roll, client portal.**
    - 12a, done on `feat/trust-accounting`:
      - Per-matter trust ledgers behind a per-firm switch.
      - No debit balances (checked under a lock); four-eyes authorisation; immutable entries with reversals.
      - Fee transfers against issued invoices; matter-to-matter transfers.
      - Three-way reconciliation with sign-off, and an auditor CSV (`docs/runbooks/trust-accounting.md`).
      - **Auditor review before live use.**
    - 12b, done on `feat/client-portal`: the client portal (`/portal`).
      - Invite by staff; an emailed one-time link plus an authenticator code; separate server-side sessions.
      - A client sees only their own matters: the attorney's update, the trust balance, shared documents, issued invoices, messages, and FICA uploads.
      - Next: SMS codes as an alternative to an authenticator (needs an SMS provider), and invoice PDFs and payment links in the portal.
    - 12c, done on `feat/court-online`: Court Online follow-ups. Court Online has no public API for practice software, so there is no direct filing or sync.
      - Court Online case numbers on matters (rolls are matched against them too).
      - A platform list of courts on Court Online, seeded from official sources (`ops courts`), with a matter banner and link.
      - Court roll notices go to the matter team plus firm-chosen watchers such as the office manager (restricted matters only to people on them).
      - One "listing changed" notice when an amended roll moves a hearing.
      - Reminders for listings in the next two days that nobody has confirmed.
      - Next: turn Court Online notification emails into matter events, once a pilot firm shares samples.

Open decisions: product name; Entra External ID vs Auth0/WorkOS; pilot firms and practice areas.
