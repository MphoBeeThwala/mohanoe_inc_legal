# Mohanoe Inc. Legal Practice Management

Legal practice management app for Mohanoe Inc. Attorneys with encrypted intake, AI-assisted triage, and a POPIA-safe data path.

## What the app does
- Captures client intake details and consent
- Encrypts raw PII before persistence
- Strips PII from the matter brief before AI assessment
- Produces attorney-facing triage notes, urgency, and next actions
- Tracks assessed matters as live cases

## Project layout
- `backend/` - Express API, intake workflow, encryption, and AI assessment
- `frontend/` - React dashboard for intake and case review
- `backend/database.sql` - Postgres/Supabase schema for production persistence

## Local development
1. Copy `.env.example` to `.env` and set the secrets you want to use.
2. Install dependencies in `backend/` and `frontend/`.
3. For first-time login without admin seeding, set `ALLOW_PUBLIC_REGISTRATION=true` in `.env`, start the backend, then use **Create account** on the sign-in screen.
4. Start the backend on port `3001`.
5. Start the frontend on port `3000`.

## Production notes
- Store `INTAKE_ENCRYPTION_KEY` as a 32-byte base64 or hex key.
- Keep Supabase as the production datastore for the first live release.
- Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to persist intake data in Postgres.
- If API calls fail with missing tables or columns in Supabase, run the SQL in [`SUPABASE_FIX.md`](SUPABASE_FIX.md) (`backend/migrations/002_full_schema_bootstrap.sql`).
- Set `ANTHROPIC_API_KEY` to enable live AI triage. Without it, the backend falls back to rules-based assessment.

## Deployment
- Recommended platform: Render.
- Use the root-level `render.yaml` blueprint for a single web service.
- The Render build copies the React build into `backend/public`, and the backend serves that directory so the UI and API stay on the same origin.
- Populate the secret env vars Render prompts for on blueprint creation: `JWT_SECRET`, `INTAKE_ENCRYPTION_KEY`, `AUDIT_CHAIN_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ANTHROPIC_API_KEY`.
- The health check endpoint is `/ready`.
- Admin auto-seeding is **deferred by default** (`SEED_ADMIN_ON_STARTUP=false`). For client demo/bootstrap, set `ALLOW_PUBLIC_REGISTRATION=true` and create the first staff account from the sign-in screen. Later, enable `SEED_ADMIN_ON_STARTUP=true` with `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD` to restore boot-time admin provisioning.
- See `PROD_OPERATIONS.md` for backup, restore, and smoke-test procedures.

## Install as a PWA

The React app ships a minimal progressive web app shell for demos:

1. Deploy or build the frontend (`npm run build --prefix frontend`) and serve over HTTPS (Render does this automatically).
2. Open the site in Chrome or Edge on desktop or Android.
3. Use **Install app** from the address bar (or browser menu → **Install Mohanoe Legal**).
4. The installed app opens in standalone mode with the Mohanoe brand colors.

Offline behavior is limited to the app shell (navigation and cached static assets). API calls require network access.

Files: `frontend/public/manifest.json`, `frontend/public/sw.js`, `frontend/public/icons/icon.svg`.

## Compliance
- Raw client PII stays encrypted at rest.
- Only redacted matter summaries are sent to AI.
- Consent is required for both storage and AI assessment.
