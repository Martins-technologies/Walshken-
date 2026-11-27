export const calendarTypes = {
  shift: "Shifts",
  task: "Tasks and deadlines",
  project: "Project deadlines",
  meeting: "Meetings and calls",
  leave: "Approved leave",
  absence: "Absences",
  statutory: "Statutory holidays",
  company: "Company holidays",
  payroll: "Payroll dates",
  approval: "Pending approvals",
  busy: "Private commitments",
} as const;

export type CalendarKind = keyof typeof calendarTypes;
export type CalendarMode = "employee" | "manager" | "admin";
export type CalendarView = "day" | "week" | "month";
export type CalendarEntry = {
  id: string;
  kind: CalendarKind;
  title: string;
  startDate: string;
  endDate: string;
  startsAt?: string;
  endsAt?: string;
  people: string[];
  status?: string;
  location?: string;
  href?: string;
};
export type CalendarPerson = { id: string; name: string; country: string; region?:string; jurisdiction?:string; departmentId: string | null; managerId: string | null };
export type CalendarOption = { id: string; name: string };
export type StaffCalendarData = {
  mode: CalendarMode;
  modes: CalendarMode[];
  view: CalendarView;
  anchor: string;
  today: string;
  from: string;
  to: string;
  customRange: boolean;
  zone: string;
  filters: { department: string; country: string; region:string; jurisdiction:string; employee: string; team: string; kinds: CalendarKind[] };
  options: { people: CalendarPerson[]; departments: CalendarOption[]; countries: CalendarOption[];regions:CalendarOption[];jurisdictions:CalendarOption[]; teams: CalendarOption[] };
  roster: (CalendarPerson & { from: string | null; to: string | null })[];
  availability: { person: string; from: string; to: string; status: string }[];
  entries: CalendarEntry[];
  holidaySetupNeeded: number;
};

export function calendarDay(day: string, delta: number) {
  return new Date(Date.parse(day + "T12:00:00Z") + delta * 86_400_000).toISOString().slice(0, 10);
}

export function calendarBounds(anchor: string, view: CalendarView) {
  if (view === "day") return { from: anchor, to: anchor };
  const first = view === "month" ? anchor.slice(0, 7) + "-01" : anchor;
  const weekday = (new Date(first + "T12:00:00Z").getUTCDay() + 6) % 7;
  const from = calendarDay(first, -weekday);
  return { from, to: calendarDay(from, view === "month" ? 41 : 6) };
}
