CREATE TABLE "platform_counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"number" text NOT NULL,
	"tax_invoice" boolean NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"supplier" jsonb NOT NULL,
	"recipient" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"vat_rate_bp" integer NOT NULL,
	"exclusive_cents" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"pf_payment_id" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_invoices_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "platform_invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "platform_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_payment_id_subscription_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."subscription_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_invoices_firm_idx" ON "platform_invoices" USING btree ("firm_id","issued_at");--> statement-breakpoint
CREATE POLICY "platform_invoices_tenant_isolation" ON "platform_invoices" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "platform_invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "platform_invoices" TO app_tenant;
