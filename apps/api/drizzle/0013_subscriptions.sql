CREATE TABLE "firm_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"state" text DEFAULT 'trialing' NOT NULL,
	"plan_code" text,
	"interval" text,
	"seats" integer,
	"recurring_amount_cents" integer,
	"trial_ends_at" timestamp with time zone,
	"paid_through" timestamp with time zone,
	"payfast_token" text,
	"cancelled_at" timestamp with time zone,
	"notices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firm_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"plan_code" text NOT NULL,
	"interval" text NOT NULL,
	"seats" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"checkout_id" uuid,
	"pf_payment_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"fee_cents" integer,
	"status" text NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"monthly_seat_price_cents" integer NOT NULL,
	"annual_seat_price_cents" integer NOT NULL,
	"min_seats" integer DEFAULT 1 NOT NULL,
	"max_seats" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "firm_subscriptions" ADD CONSTRAINT "firm_subscriptions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_checkout_id_subscription_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."subscription_checkouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "firm_subscriptions_firm_idx" ON "firm_subscriptions" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "subscription_checkouts_firm_idx" ON "subscription_checkouts" USING btree ("firm_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payments_pf_idx" ON "subscription_payments" USING btree ("firm_id","pf_payment_id");--> statement-breakpoint
CREATE POLICY "firm_subscriptions_tenant_isolation" ON "firm_subscriptions" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_checkouts_tenant_isolation" ON "subscription_checkouts" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_payments_tenant_isolation" ON "subscription_payments" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "firm_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_checkouts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "firm_subscriptions", "subscription_checkouts", "subscription_payments" TO app_tenant;
--> statement-breakpoint
GRANT SELECT ON "subscription_plans" TO app_tenant;
