# Production Operations Runbook

## Datastore
- Keep Supabase as the production datastore for the first live release.
- Reason: the app already uses Supabase client access, encrypted intake storage, and RLS policies. A Render Postgres migration would require a data-layer rewrite and new migration verification.

## Backups
- Use Supabase managed backups as the primary recovery path.
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
