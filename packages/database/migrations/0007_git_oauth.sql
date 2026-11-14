CREATE TABLE "git_forges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_ref" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_oauth_flows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"forge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text DEFAULT '/settings/git' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_connections" ADD COLUMN "forge_id" uuid;--> statement-breakpoint
ALTER TABLE "git_oauth_flows" ADD CONSTRAINT "git_oauth_flows_forge_id_git_forges_id_fk" FOREIGN KEY ("forge_id") REFERENCES "public"."git_forges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_oauth_flows" ADD CONSTRAINT "git_oauth_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_forges_host_uq" ON "git_forges" USING btree (lower("host"));--> statement-breakpoint
CREATE UNIQUE INDEX "git_oauth_flows_state_uq" ON "git_oauth_flows" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "git_oauth_flows_expires_at_index" ON "git_oauth_flows" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_forge_id_git_forges_id_fk" FOREIGN KEY ("forge_id") REFERENCES "public"."git_forges"("id") ON DELETE set null ON UPDATE no action;