CREATE TABLE "auth_flows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"nonce" text,
	"code_verifier" text,
	"return_to" text DEFAULT '/' NOT NULL,
	"link_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_flows" ADD CONSTRAINT "auth_flows_provider_id_auth_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."auth_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_flows" ADD CONSTRAINT "auth_flows_link_user_id_users_id_fk" FOREIGN KEY ("link_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_flows_state_uq" ON "auth_flows" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "auth_flows_expires_at_index" ON "auth_flows" USING btree ("expires_at");