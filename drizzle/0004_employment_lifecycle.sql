ALTER TABLE "employees" ADD COLUMN "employment_status" text DEFAULT 'Active' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "holiday_days" integer;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employee_employment_status" CHECK ("employees"."employment_status" in ('Active','On leave','Ended'));