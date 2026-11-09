# Ahava on 88 — Legal Practice Management (white-label SaaS)

Owner: Ahava on 88 (Pty) Ltd. The product is licensed to individual law firms. The plan and build order live in `docs/ROADMAP.md`; read the relevant section before starting an epic, and tick its checklist when done.

## Non-negotiables
- **No hard-coded brands.** Firm branding comes from `backend/config/brand.js` (env today, the `firms` table after epic 4). `node scripts/check-legacy-brand.js` must pass.
- **Tenant isolation (from epic 4):** every table has `firm_id`; every query runs with `app.firm_id` set; never use a DB role that bypasses RLS; every endpoint gets an isolation test.
- **Every new endpoint:** input validation, `authenticateRequest`, `requireRoles(...)`, tests.
- **Client personal information** is encrypted before storage (`privacy.service.js`; per-firm Key Vault keys after epic 6). Never log personal information.
- **AI** only receives de-identified briefs; output must cite retrieved sources (roadmap §7); AI failures surface as errors.
- **Money** is integer cents (ZAR); VAT 15% configurable; invoice numbers sequential and gap-free per firm.
- **Production fails fast:** `backend/config/env.js` refuses to boot without real secrets. Don't add silent fallbacks that run in production.
- Migrations are additive and reversible; no manual SQL in production.

## Stack
- npm workspaces: `apps/api` (Express 5, Node 22, strict TypeScript compiled to CommonJS), `apps/web` (React 18 + Vite, strict TypeScript), `packages/shared` (shared types — put API request/response shapes here).
- Tests: Vitest everywhere; API HTTP tests use Supertest against the real app (`apps/api/src/test/`). Import `./memory-env` first in API tests that need the in-memory store.
- Data layer today: Supabase client with loose `DbRow` types (`apps/api/src/types/db.ts`) — replaced by Drizzle in epic 3. Don't spread `DbRow` further than needed.
- Errors: throw `httpError(message, status)`; controllers answer with `sendError(res, error)`.
- Target infra: Azure South Africa North (DR: South Africa West) via Terraform — Container Apps, PostgreSQL Flexible Server, Blob Storage, Key Vault, Service Bus, Entra External ID, Front Door. Claude via Microsoft Foundry (Sweden Central) behind one AI client interface.

## Workflow
- One epic per branch, one PR per task; branch from up-to-date `main`.
- Before pushing (repo root): `npm run check:brand && npm run format:check && npm run typecheck && npm test && npm run build`.
- Keep secrets out of the repo; use `.env.example` for new variables and document them in `README.md`.
