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
3. Start the backend on port `3001`.
4. Start the frontend on port `3000`.

## Production notes
- Store `INTAKE_ENCRYPTION_KEY` as a 32-byte base64 or hex key.
- Keep Supabase as the production datastore for the first live release.
- Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to persist intake data in Postgres.
- Set `ANTHROPIC_API_KEY` to enable live AI triage. Without it, the backend falls back to rules-based assessment.

## Deployment
- Recommended platform: Render.
- Use the root-level `render.yaml` blueprint for a single web service.
- The Render build copies the React build into `backend/public`, and the backend serves that directory so the UI and API stay on the same origin.
- Populate the secret env vars Render prompts for on blueprint creation: `JWT_SECRET`, `INTAKE_ENCRYPTION_KEY`, `AUDIT_CHAIN_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `DEFAULT_ADMIN_EMAIL`, and `DEFAULT_ADMIN_PASSWORD`.
- If you need a temporary access workaround, set `EMERGENCY_ADMIN_LOGIN=true` and sign in from `/` with `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD`. Turn it back off after access is restored.
- If startup seeding fails or an existing admin password needs a secure reset, set `ADMIN_BOOTSTRAP_TOKEN` temporarily and call `POST /api/auth/bootstrap-admin` with `fullName`, `email`, `password`, and `token`. Remove the token env var after successful bootstrap.
- The health check endpoint is `/ready`.
- `ALLOW_PUBLIC_REGISTRATION` is disabled by default; staff access should be seeded by an admin account.
- See `PROD_OPERATIONS.md` for backup, restore, and smoke-test procedures.

## Compliance
- Raw client PII stays encrypted at rest.
- Only redacted matter summaries are sent to AI.
- Consent is required for both storage and AI assessment.
