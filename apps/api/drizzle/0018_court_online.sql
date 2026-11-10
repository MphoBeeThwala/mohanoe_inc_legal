CREATE TABLE "court_online_courts" (
	"division" text PRIMARY KEY NOT NULL,
	"since" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "court_online_reference" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "court_online_key" text;--> statement-breakpoint
ALTER TABLE "court_roll_matches" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "firms" ADD COLUMN "notification_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "cases_court_online_key_idx" ON "cases" USING btree ("court_division","court_online_key");--> statement-breakpoint
GRANT SELECT ON "court_online_courts" TO app_tenant;
--> statement-breakpoint
GRANT UPDATE ("notification_settings") ON "firms" TO app_tenant;
--> statement-breakpoint
-- Courts known to use Court Online, from official sources (operators keep this current).
INSERT INTO "court_online_courts" ("division", "since", "source") VALUES
  ('ZAGPPHC', '2022-02-23', 'Gauteng Division: Acting Judge President''s notice on the Court Online pilot, 23 February 2022'),
  ('ZAGPJHC', '2022-02-23', 'Gauteng Division: Acting Judge President''s notice on the Court Online pilot, 23 February 2022'),
  ('ZALCJHB', '2025-03-28', 'Labour Court Directive 01 of 2025 (Court Online), 28 March 2025'),
  ('ZAKZPHC', '2025-04-01', 'Minister of Justice, reply to question NW3556 (Court Online rollout)'),
  ('ZALMPPHC', '2025-05-06', 'Minister of Justice, reply to question NW3556 (Court Online rollout)'),
  ('ZAMPMBHC', '2025-05-21', 'Minister of Justice, reply to question NW3556 (Court Online rollout)')
ON CONFLICT DO NOTHING;
