CREATE TABLE "service_catalog" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"port" integer,
	"health_command" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_memory_mb" integer DEFAULT 512 NOT NULL,
	"max_memory_mb" integer DEFAULT 2048 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "service_catalog_key_uq" ON "service_catalog" USING btree ("key");--> statement-breakpoint
INSERT INTO "service_catalog" ("key", "name", "image", "port", "health_command", "default_env", "default_memory_mb", "max_memory_mb") VALUES
  ('postgres', 'PostgreSQL 17', 'postgres:17.11-alpine', 5432, '["pg_isready","-h","127.0.0.1","-U","postgres"]', '{"POSTGRES_PASSWORD":"postgres","POSTGRES_DB":"app"}', 512, 4096),
  ('redis', 'Redis 8', 'redis:8.6.8-alpine', 6379, '["redis-cli","-h","127.0.0.1","ping"]', '{}', 256, 2048),
  ('rabbitmq', 'RabbitMQ 4 (avec console)', 'rabbitmq:4.3.7-management-alpine', 5672, '["rabbitmq-diagnostics","-q","ping"]', '{}', 512, 2048)
ON CONFLICT ("key") DO NOTHING;
