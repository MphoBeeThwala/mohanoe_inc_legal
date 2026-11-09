# Production Operations Runbook

## Datastore
- Any PostgreSQL 15+ reached through `DATABASE_URL` (the app uses Drizzle ORM over node-postgres; no vendor SDK).
- Target: Azure Database for PostgreSQL Flexible Server, South Africa North (see `docs/ROADMAP.md` §4). Interim: any managed Postgres, e.g. a Supabase project's Postgres connection string.
- Migrations live in `apps/api/drizzle/` and are applied on start (or by `npm run db:migrate -w apps/api` with `DB_MIGRATE_ON_START=false`).
- `INTAKE_ENCRYPTION_KEY` and `AUDIT_CHAIN_SECRET` must be backed up with the database: without the first, client data cannot be decrypted (it wraps firm keys when `KEY_PROVIDER=local`, and decrypts pre-epic-6 data); without the second, the audit chain cannot be verified. With Key Vault, enable soft-delete and purge protection: deleting the Key Vault key makes every firm's data unreadable.

## Tenancy and the `app_tenant` role
- Every request runs inside a transaction as the `app_tenant` role, with `app.firm_id` set; row-level security is forced on every tenant table, so a missing or wrong firm returns no rows.
- Migration `0001_multi_tenancy` creates `app_tenant` (NOLOGIN) and grants it to the migrating user. On a shared server where `app_tenant` already exists and the owner cannot be granted it, the migration stops with the exact command to run, e.g. `GRANT app_tenant TO <owner>;` (run once by an administrator, then redeploy).
- Never point the app at a role with `BYPASSRLS`, and don't grant `app_tenant` extra privileges by hand.
- Matter-level access is also enforced in the database: migration `0002` adds `app_case_visible()` and restrictive `*_matter_access` policies for `app_tenant`. Requests record the signed-in user in `app.user_id` / `app.user_role`; platform jobs and compliance exports use `app.principal = 'system'`.
- Upgrading a single-firm database moves all existing rows into a firm with slug `default`; set `DEFAULT_FIRM_SLUG=default` (or give the firm a domain) so the existing URL keeps working.

## Firm onboarding
- `npm run firm -w apps/api -- create --slug <slug> --name "<legal name>" [--prefix ABC] [--domain host] [--admin-email … --admin-name …]`
- The CLI needs the same `DATABASE_URL`, `JWT_SECRET`, `INTAKE_ENCRYPTION_KEY` and `AUDIT_CHAIN_SECRET` as the server; it refuses to run without them. Otherwise the admin's email would be encrypted with the wrong key and the audit chain would break.
- Point the firm's DNS (subdomain or custom domain) at the app; the host name selects the firm.

## Encryption keys
- **After upgrading to epic 6:** run `npm run ops -w apps/api -- keys reencrypt` once. It moves existing data to per-firm keys and is safe to re-run. Check with `keys status`.
- **Moving to Azure Key Vault:** create an RSA key (HSM-backed in production) and give the app's managed identity *Key Vault Crypto User* on it. Set `KEY_PROVIDER=azure-keyvault` and `AZURE_KEY_VAULT_KEY_ID`, keep `INTAKE_ENCRYPTION_KEY`, deploy, then run `keys rewrap`.
- **Rotating a firm's data key** (yearly, or after an incident): `keys rotate --slug <firm>`, `keys reencrypt --slug <firm>`, `keys prune --slug <firm>`.
- **Rotating the Key Vault key:** create a new version in Key Vault, then run `keys rewrap`. Old versions must stay enabled until the rewrap finishes.
- **Rotating `INTAKE_ENCRYPTION_KEY`** (local KEK): first run `keys reencrypt` so no `v1:` data is left. Then set the new value, put the old one in `INTAKE_ENCRYPTION_KEY_PREVIOUS`, run `keys rewrap`, and remove the previous value.

## Audit anchors and storage
- **Production storage:** `OBJECT_STORE=azure-blob` with `AZURE_STORAGE_ACCOUNT_URL`; the managed identity needs *Storage Blob Data Contributor*. Firms' document containers are created on first use.
- **The anchor container** (`AUDIT_ANCHOR_CONTAINER`) needs a locked, time-based immutability policy (e.g. 10 years) and versioning. Set both in infrastructure, not in the app.
- **Daily anchoring:** schedule `npm run ops -w apps/api -- anchor` (Container Apps job), or set `AUDIT_ANCHOR_INTERVAL_HOURS=24`.

## Firm exit
- `npm run firm -w apps/api -- export --slug <firm> --out <file.json>` produces a full decrypted export (owner-only file permissions).
- Hand it over securely, then delete the file. The export is recorded in the firm's audit trail.

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

## Staff access
- There is no public registration and no admin seeding. The first administrator of a firm is invited with the CLI (`npm run firm -w apps/api -- invite --slug <slug> --email <email> --name "<name>"`); they invite everyone else from **Account & team**.
- Every password account uses an authenticator app. Lost phone: the user signs in with a recovery code, or an administrator uses **Reset two-factor** (they set it up again at next sign-in).
- Locked out (5 failures): wait 15 minutes, or an administrator issues **Reset password** (the link also lifts the lock).
- Leavers: **Deactivate** signs them out everywhere at once.
- Set `SMTP_URL` and `MAIL_FROM` (Azure Communication Services Email supports SMTP) so invites and self-service resets are emailed; without it, links are shown to the administrator only.
- Entra External ID: create an app registration in the External ID tenant, enable MFA in the user flow, add `https://<firm address>/api/auth/oidc/callback` for each firm, then set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Production refuses an `http://` issuer.
- Existing password accounts from before this release set up an authenticator at their next sign-in.

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
