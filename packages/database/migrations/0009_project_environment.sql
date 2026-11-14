CREATE TABLE "environment_variables" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"value" text,
	"secret_ref" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sandbox_image_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "setup_script" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "setup_hash" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "setup_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "setup_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "setup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variables_uq" ON "environment_variables" USING btree ("scope","subject_id","name");--> statement-breakpoint
CREATE INDEX "environment_variables_subject_id_index" ON "environment_variables" USING btree ("subject_id");