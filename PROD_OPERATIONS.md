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

## Microsoft 365 sign-in for firms
- Register one **multi-tenant** app in Ahava's Entra ID (accounts in any organizational directory), with a client secret, and set `ENTRA_WORKFORCE_CLIENT_ID` and `ENTRA_WORKFORCE_CLIENT_SECRET`.
- For every firm address, add a redirect URI `https://<firm address>/api/auth/oidc/callback`.
- The firm's administrators do the rest in the app. Recommend that their IT enforces MFA with Conditional Access for this app.

## Platform support
- Create operators only for named Ahava on 88 staff: `npm run ops -w apps/api -- operator create --email … --name "…"`. Hand over the printed password and authenticator key in person or through a password manager.
- Disable leavers the same day: `operator disable --email …`. Operators lock for 15 minutes after 5 failed attempts.
- Support work starts with the firm granting access in the app. Never ask a firm for a staff password. The firm sees the grant and every support request in its audit trail.

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
- PostgreSQL Flexible Server: point-in-time restore for 35 days, geo-redundant backups to South Africa West in production. Documents and audit anchors: versioned, soft-deleted and geo-replicated Blob Storage.
- Disaster recovery: [`docs/runbooks/disaster-recovery.md`](docs/runbooks/disaster-recovery.md).

## Restore Test
- Quarterly, and before the first firm goes live: [`docs/runbooks/restore-test.md`](docs/runbooks/restore-test.md).
- `npm run ops -w apps/api -- restore-check` on the restored copy checks migrations, every firm's audit chain, decryption samples and counts (exit code 1 on failure).

## Staff access
- There is no public registration and no admin seeding. The first administrator of a firm is invited with the CLI (`npm run firm -w apps/api -- invite --slug <slug> --email <email> --name "<name>"`); they invite everyone else from **Account & team**.
- Every password account uses an authenticator app. Lost phone: the user signs in with a recovery code, or an administrator uses **Reset two-factor** (they set it up again at next sign-in).
- Locked out (5 failures): wait 15 minutes, or an administrator issues **Reset password** (the link also lifts the lock).
- Leavers: **Deactivate** signs them out everywhere at once.
- Set `SMTP_URL` and `MAIL_FROM` (Azure Communication Services Email supports SMTP) so invites and self-service resets are emailed; without it, links are shown to the administrator only.
- Entra External ID: create an app registration in the External ID tenant, enable MFA in the user flow, add `https://<firm address>/api/auth/oidc/callback` for each firm, then set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Production refuses an `http://` issuer.
- Existing password accounts from before this release set up an authenticator at their next sign-in.

## Deploy
- Azure (target): [`docs/runbooks/deployment.md`](docs/runbooks/deployment.md). The Deploy workflow migrates, updates the scheduled jobs and the API, and checks `/ready` through Front Door.
- Render (interim): after a deploy run `node scripts/smoke-test.js https://<host>` (checks `/health`, `/ready` and the React shell).

## Monitoring and incidents
- Alerts (email to `alert_emails`): availability test on `/ready`, Front Door 5xx, API restarts, PostgreSQL CPU and storage, failed scheduled jobs, monthly budget.
- Errors: 5xx responses log one JSON line with a request ID; set `SENTRY_DSN` to send them to Sentry (no request bodies, headers, cookies, users or query strings; emails and ID numbers are scrubbed). Production answers 5xx with a generic message and the request ID.
- Incidents and POPIA breach notification: [`docs/runbooks/incident-response.md`](docs/runbooks/incident-response.md).

## Remaining Production Checks
- Confirm audit chain verification returns valid for every firm.
- Confirm a live end-to-end intake submission works on the deployed URL.
- Pass a restore test before accepting client data.
