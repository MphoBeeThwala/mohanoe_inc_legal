-- Encryption and records (roadmap epic 6).
-- 1. firm_keys: per-firm data keys, stored wrapped by a key-encryption key
--    (Azure Key Vault or the local INTAKE_ENCRYPTION_KEY). Existing v1
--    ciphertext keeps decrypting with INTAKE_ENCRYPTION_KEY until
--    `npm run ops -w apps/api -- keys reencrypt` moves it to the firm key.
-- 2. Documents can live in an object store (storage_key).
-- 3. audit_anchors: daily anchors of each firm's audit chain head.
-- 4. Per-firm retention (firms.retention_days), which a firm's admins set:
--    app_tenant may update only its own firm's row, and only that column.
CREATE TABLE "audit_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_hash" text NOT NULL,
	"event_count" integer NOT NULL,
	"object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_anchors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "firm_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"purpose" text NOT NULL,
	"version" integer NOT NULL,
	"wrapped_key" text NOT NULL,
	"kek_provider" text NOT NULL,
	"kek_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firm_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "firms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "encrypted_content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content_key_version" integer;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_keys" ADD CONSTRAINT "firm_keys_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_anchors_last_seq_idx" ON "audit_anchors" USING btree ("last_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "firm_keys_firm_purpose_version_idx" ON "firm_keys" USING btree ("firm_id","purpose","version");--> statement-breakpoint
CREATE POLICY "firms_tenant_read" ON "firms" AS PERMISSIVE FOR SELECT TO "app_tenant" USING (true);--> statement-breakpoint
CREATE POLICY "firms_tenant_update_own" ON "firms" AS PERMISSIVE FOR UPDATE TO "app_tenant" USING (id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_anchors_tenant_isolation" ON "audit_anchors" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "firm_keys_tenant_isolation" ON "firm_keys" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "firm_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_anchors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "firm_keys", "audit_anchors" TO app_tenant;
--> statement-breakpoint
GRANT UPDATE ("retention_days", "updated_at") ON "firms" TO app_tenant;
