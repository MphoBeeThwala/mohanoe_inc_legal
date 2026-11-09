# Production Operations Runbook

## Datastore
- Any PostgreSQL 15+ reached through `DATABASE_URL` (the app uses Drizzle ORM over node-postgres; no vendor SDK).
- Target: Azure Database for PostgreSQL Flexible Server, South Africa North (see `docs/ROADMAP.md` §4). Interim: any managed Postgres, e.g. a Supabase project's Postgres connection string.
- Migrations live in `apps/api/drizzle/` and are applied on start (or by `npm run db:migrate -w apps/api` with `DB_MIGRATE_ON_START=false`).
- `INTAKE_ENCRYPTION_KEY` and `AUDIT_CHAIN_SECRET` must be backed up with the database: without the first, client data cannot be decrypted; without the second, the audit chain cannot be verified.

## Tenancy and the `app_tenant` role
- Every request runs inside a transaction as the `app_tenant` role, with `app.firm_id` set; row-level security is forced on every tenant table, so a missing or wrong firm returns no rows.
- Migration `0001_multi_tenancy` creates `app_tenant` (NOLOGIN) and grants it to the migrating user. On a shared server where `app_tenant` already exists and the owner cannot be granted it, the migration stops with the exact command to run, e.g. `GRANT app_tenant TO <owner>;` (run once by an administrator, then redeploy).
- Never point the app at a role with `BYPASSRLS`, and don't grant `app_tenant` extra privileges by hand.
- Upgrading a single-firm database moves all existing rows into a firm with slug `default`; set `DEFAULT_FIRM_SLUG=default` (or give the firm a domain) so the existing URL keeps working.

## Firm onboarding
- `npm run firm -w apps/api -- create --slug <slug> --name "<legal name>" [--prefix ABC] [--domain host] [--admin-email … --admin-name …]`
- The CLI needs the same `DATABASE_URL`, `JWT_SECRET`, `INTAKE_ENCRYPTION_KEY` and `AUDIT_CHAIN_SECRET` as the server; it refuses to run without them. Otherwise the admin's email would be encrypted with the wrong key and the audit chain would break.
- Point the firm's DNS (subdomain or custom domain) at the app; the host name selects the firm.

## Backups
- Use the provider's managed backups with point-in-time recovery as the primary recovery path.
- Before client go-live, verify:
  - backup retention window
  - point-in-time recovery / restore support on the chosen plan
  - a documented owner for restore approval

## Restore Test
- Perform one non-production restore test before accepting client data.
- Verify after restore:
  - staff login works
  - intake records still decrypt
  - case, billing, calendar, and audit records still load
  - compliance export still returns a complete subject bundle
  - `GET /api/audit/verify` (admin) returns `valid: true` for each firm (each firm has its own chain)

## Admin Provisioning
- **Current demo phase:** `SEED_ADMIN_ON_STARTUP` defaults to `false`. Set `ALLOW_PUBLIC_REGISTRATION=true` to let the first presenter create a staff account from the UI, then disable public registration before go-live.
- **Later stage:** set `SEED_ADMIN_ON_STARTUP=true` with `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD` to auto-provision the initial admin on server boot.
- Do not leave public registration enabled in production after staff accounts exist.

## Deploy Smoke Test
- After Render deploys, run:

```bash
node scripts/smoke-test.js https://your-render-url.onrender.com
```

Expected checks:
- `/health`
- `/ready`
- `/` returns the React shell

## Remaining Production Checks
- Confirm Render env vars are set.
- Confirm Supabase env vars are set.
- Confirm audit chain verification returns valid.
- Confirm a live end-to-end intake submission works on the deployed URL.
