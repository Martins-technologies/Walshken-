CREATE TABLE "staff_avatars" (
	"employee_id" text PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"content" "bytea" NOT NULL,
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_mfa" (
	"employee_id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"setup_expires_at" text NOT NULL,
	"confirmed_at" text,
	"last_step" integer DEFAULT -1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_recovery_codes" (
	"employee_id" text NOT NULL,
	"code_hash" text NOT NULL,
	CONSTRAINT "staff_recovery_codes_employee_id_code_hash_pk" PRIMARY KEY("employee_id","code_hash")
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "work_schedule" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "holiday_calendar" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "first_login_at" text;--> statement-breakpoint
ALTER TABLE "staff_avatars" ADD CONSTRAINT "staff_avatars_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_mfa" ADD CONSTRAINT "staff_mfa_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_recovery_codes" ADD CONSTRAINT "staff_recovery_codes_employee_id_staff_mfa_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_mfa"("employee_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE public.staff_avatars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_recovery_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.staff_avatars, public.staff_mfa, public.staff_recovery_codes FROM PUBLIC;
--> statement-breakpoint
DO $staff_guards$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.staff_avatars, public.staff_mfa, public.staff_recovery_codes FROM %I', client_role);
    END IF;
  END LOOP;
END $staff_guards$;
--> statement-breakpoint
UPDATE public.employees AS e SET first_login_at=history.first_seen
FROM (SELECT employee_id,MIN(created_at) AS first_seen FROM public.sessions GROUP BY employee_id) AS history
WHERE e.id=history.employee_id AND e.first_login_at IS NULL;
