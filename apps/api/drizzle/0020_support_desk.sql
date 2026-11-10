CREATE TABLE "help_articles" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author" text NOT NULL,
	"user_id" uuid,
	"operator_id" uuid,
	"operator_name" text,
	"body_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid DEFAULT nullif(current_setting('app.firm_id', true), '')::uuid NOT NULL,
	"number" text NOT NULL,
	"created_by" uuid,
	"category" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject_encrypted" text NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_response_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_ticket_messages_ticket_idx" ON "support_ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_number_idx" ON "support_tickets" USING btree ("firm_id","number");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status","last_message_at");--> statement-breakpoint
CREATE POLICY "support_ticket_messages_tenant_isolation" ON "support_ticket_messages" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "support_tickets_tenant_isolation" ON "support_tickets" AS PERMISSIVE FOR ALL TO public USING (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid) WITH CHECK (firm_id = nullif(current_setting('app.firm_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "support_tickets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_ticket_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_tickets", "support_ticket_messages" TO app_tenant;
--> statement-breakpoint
GRANT SELECT ON "help_articles" TO app_tenant;
--> statement-breakpoint
INSERT INTO "help_articles" ("slug", "title", "category", "body", "sort_order") VALUES
('signing-in', 'Signing in and authenticator codes', 'Getting started', 'Every sign-in takes your password and a six-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator or similar). The code changes every 30 seconds.

# If you have a new phone
- Use one of the recovery codes you saved when you set up the authenticator, then set up the app again under Account & team.
- No recovery codes left? Ask your firm''s administrator to reset your authenticator.

# If you are locked out
After several wrong attempts the account is locked for a short while. Wait, then try again, or use Forgot password on the sign-in page.', 1),
('inviting-staff', 'Inviting staff and choosing roles', 'Getting started', 'Staff join only by invitation. An administrator invites them under Account & team → Staff, choosing a role.

# Roles
- Administrator: firm settings, staff, subscription and everything else.
- Attorney: matters, time, billing, research, and authorising trust payments.
- Paralegal: matters, time and research.
- Secretary: intake, clients, the calendar and the client portal.
- Bookkeeper: billing, reports and trust records (never authorising).

The invitation link expires after a few days; send a new one if it has.', 2),
('support-access', 'Letting support see your firm''s records', 'Support', 'Platform support has no access to your firm''s records unless an administrator gives it.

- Go to Account & team → Support access, choose how long (1 hour to 3 days) and give a reason.
- Support can only read, and matters you have restricted stay hidden.
- Every page support opens is recorded in your audit trail.
- You can end the access at any time.', 3),
('raising-a-request', 'Raising a support request', 'Support', 'Use Help → New request. Describe what you were doing and what went wrong, and choose Urgent only if work has stopped.

# Please do not include client details
Write the matter number (for example MAT-2026-0012) instead of names, ID numbers or case facts. Support reads your request but should not need any client''s personal information.

You get an email when support replies; the reply itself is only shown here, in the app.', 4),
('exporting-records', 'Exporting your firm''s records', 'Your records', 'An administrator can export all of the firm''s records under Account & team → Records. The export includes matters, clients, documents, time, invoices and the audit trail.

Your records stay readable and exportable even if the subscription lapses.', 5),
('read-only-mode', 'Why the workspace is read-only', 'Subscription', 'If the subscription is unpaid after the grace period, the workspace becomes read-only: you can still read and export everything, but not add or change records.

An administrator can pay or choose a plan under Account & team → Subscription; changes are possible again as soon as PayFast confirms the payment.', 6);
