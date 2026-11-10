CREATE TABLE "trust_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'trust' NOT NULL,
	"bank_name" text NOT NULL,
	"account_number_encrypted" text NOT NULL,
	"account_last4" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trust_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "trust_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"entry_date" date NOT NULL,
	"reference_encrypted" text NOT NULL,
	"description_encrypted" text NOT NULL,
	"status" text NOT NULL,
	"invoice_id" uuid,
	"group_id" uuid,
	"reverses_id" uuid,
	"requested_by" uuid,
	"authorised_by" uuid,
	"authorised_at" timestamp with time zone,
	"rejected_reason" text,
	"cleared_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trust_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "trust_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"bank_balance_cents" bigint NOT NULL,
	"cashbook_cents" bigint NOT NULL,
	"ledger_total_cents" bigint NOT NULL,
	"uncleared_receipts_cents" bigint NOT NULL,
	"uncleared_payments_cents" bigint NOT NULL,
	"debit_ledgers" integer NOT NULL,
	"notes_encrypted" text,
	"prepared_by" uuid,
	"signed_off_by" uuid,
	"signed_off_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "features" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "trust_accounts" ADD CONSTRAINT "trust_accounts_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_entries" ADD CONSTRAINT "trust_entries_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_entries" ADD CONSTRAINT "trust_entries_account_id_trust_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_entries" ADD CONSTRAINT "trust_entries_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_entries" ADD CONSTRAINT "trust_entries_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_entries" ADD CONSTRAINT "trust_entries_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_entries" ADD CONSTRAINT "trust_entries_authorised_by_users_id_fk" FOREIGN KEY ("authorised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ADD CONSTRAINT "trust_reconciliations_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ADD CONSTRAINT "trust_reconciliations_account_id_trust_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trust_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ADD CONSTRAINT "trust_reconciliations_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_reconciliations" ADD CONSTRAINT "trust_reconciliations_signed_off_by_users_id_fk" FOREIGN KEY ("signed_off_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trust_entries_ledger_idx" ON "trust_entries" USING btree ("account_id","case_id","status");--> statement-breakpoint
CREATE INDEX "trust_entries_date_idx" ON "trust_entries" USING btree ("account_id","entry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "trust_entries_reversal_idx" ON "trust_entries" USING btree ("reverses_id") WHERE "trust_entries"."reverses_id" is not null and "trust_entries"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "trust_reconciliations_account_idx" ON "trust_reconciliations" USING btree ("account_id","period_end");--> statement-breakpoint
CREATE POLICY "trust_accounts_tenant_isolation" ON "trust_accounts" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "trust_entries_tenant_isolation" ON "trust_entries" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "trust_entries_matter_access" ON "trust_entries" AS RESTRICTIVE FOR ALL TO "app_tenant" USING (exists (select 1 from cases c where c.id = trust_entries.case_id)) WITH CHECK (exists (select 1 from cases c where c.id = trust_entries.case_id));--> statement-breakpoint
CREATE POLICY "trust_reconciliations_tenant_isolation" ON "trust_reconciliations" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "trust_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trust_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trust_reconciliations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Posted trust entries are never deleted: no DELETE for requests.
GRANT SELECT, INSERT, UPDATE ON "trust_accounts", "trust_entries", "trust_reconciliations" TO app_tenant;
