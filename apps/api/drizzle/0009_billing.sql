-- Billing (roadmap epic 7): draft and issued invoices with gap-free numbers,
-- encrypted invoice content, disbursements, payments and firm billing settings.
CREATE TABLE "disbursements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"incurred_on" date NOT NULL,
	"description_encrypted" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"vatable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unbilled' NOT NULL,
	"invoice_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "disbursements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"received_on" date NOT NULL,
	"method" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "invoice_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "subject" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "issued_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "issued_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "billing_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "content_encrypted" text;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "client_party_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "vat_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "paid_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disbursements_case_idx" ON "disbursements" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments" USING btree ("invoice_id");--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_client_party_id_parties_id_fk" FOREIGN KEY ("client_party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "disbursements_tenant_isolation" ON "disbursements" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "disbursements_matter_access" ON "disbursements" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = disbursements.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = disbursements.case_id));--> statement-breakpoint
CREATE POLICY "invoice_payments_tenant_isolation" ON "invoice_payments" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "invoice_payments_matter_access" ON "invoice_payments" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = invoice_payments.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = invoice_payments.case_id));--> statement-breakpoint
ALTER TABLE "disbursements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "disbursements", "invoice_payments" TO app_tenant;
--> statement-breakpoint
GRANT UPDATE ("billing_settings", "vat_number") ON "firms" TO app_tenant;
