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
- Do not enable public registration in production.
- Set `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD` during deployment so the app seeds the initial admin account.
- Use the admin account to create additional staff as needed.

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
