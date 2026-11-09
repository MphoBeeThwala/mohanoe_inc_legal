# Restore test (quarterly, and before the first firm goes live)

Goal: prove a backup becomes a working system within the RTO (4 hours) and loses no more than the RPO (15 minutes). Record each test in the operations log: date, who, restore point, timings, result.

1. **Pick a restore point** within the last 15 minutes of a known write (note the time).
2. **Restore PostgreSQL** to a new server in the staging subscription (never over production):
   `az postgres flexible-server restore --resource-group <staging-rg> --name restore-<date> --source-server <prod server id> --restore-time <ISO time>`
   For the DR test, use `geo-restore` into **South Africa West** instead.
3. **Point a staging copy of the app at it**: same image, the restored `DATABASE_URL`, and the production key setup (`KEY_PROVIDER=azure-keyvault`, the production key ID; the staging identity needs temporary *Crypto User* on the key — remove it afterwards).
4. **Run the restore check** (as a one-off job or `az containerapp exec`):
   `node apps/api/dist/scripts/ops.js restore-check`
   It confirms every migration is applied, every firm's audit chain verifies (including against its anchors), samples of encrypted records decrypt (parties, intakes, invoices, time, calendar), and prints row counts. Exit code 1 means fail.
5. **Manual checks** on the restored copy: a staff member signs in with MFA; a matter, an invoice PDF and a calendar view load; a document downloads (Blob Storage is shared and versioned, so documents are not part of the database restore); the compliance export returns a full subject bundle.
6. **Clean up**: delete the restored server and the temporary role assignment.

Fail? Treat it as a P2 incident (`incident-response.md`): the backups are not trustworthy until a test passes.
