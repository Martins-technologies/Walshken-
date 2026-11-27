export const performanceFactors = {
  attendance: "Attendance",
  punctuality: "Punctuality",
  tasks: "Tasks completed",
  projects: "Projects completed",
  milestones: "Milestones completed",
  review: "Approved manager assessment",
  quality: "Approved work quality assessment",
} as const;

export type PerformanceFactor = keyof typeof performanceFactors;
export type PerformanceWeights = Record<PerformanceFactor, number>;
export type PerformanceModel = {
  version: string;
  effectiveMonth: string | null;
  weights: PerformanceWeights;
};

export const arrivalStatuses = ["On time", "Early", "Late", "Absent", "Missing check-in", "Pending", "Upcoming", "Excluded"] as const;
export type ArrivalStatus = typeof arrivalStatuses[number];
export type ArrivalRecord = {
  id: string;
  employeeId: string;
  day: string;
  scheduled: string;
  checkedIn: string | null;
  differenceMinutes: number | null;
  graceMinutes: number;
  timeZone: string;
  status: ArrivalStatus;
  reason: string;
};

export type ArrivalTotals = { expected: number; attended: number; onTime: number; early: number; late: number;
  absent: number; missing: number; pending: number; upcoming: number; excluded: number;
  attendancePercent: number | null; punctualityPercent: number | null;
};

export type CompletionMetrics = { due: number; completed: number; completedThisMonth: number; percent: number | null };
export type PerformanceEmployee = {
  id: string;
  departmentId: string | null;
  department: string;
  designation: string;
  attendance: ArrivalTotals;
  tasks: CompletionMetrics;
  projects: CompletionMetrics;
  milestones: CompletionMetrics;
  review: number | null;
  quality: number | null;
  score: number | null;
  reason: string | null;
  measuredWeight: number;
  factors: Record<PerformanceFactor, number | null>;
};
export type PerformancePerson = { id: string; name: string; hasPhoto: boolean; departmentId: string | null; department: string };
export type RankedEmployee = PerformanceEmployee & PerformancePerson & { rank: number | null; punctualityRank: number | null };
export type PerformanceAssessment = {
  id: string; employee_id: string; review_score: number; quality_score: number | null;
  evidence: string; created_at: string; decision: string | null; canDecide: boolean;
};
export type PerformanceDepartment = {
  id: string | null; department: string; employees: number; ranked: number;
  score: number | null; attendance: ArrivalTotals; tasks: CompletionMetrics;
  projects: CompletionMetrics; milestones: CompletionMetrics;
};
export type PerformanceTrend = {
  month: string; finalized: boolean; employees: number; ranked: number; score: number | null;
  attendance: ArrivalTotals; tasks: CompletionMetrics; projects: CompletionMetrics; milestones: CompletionMetrics;
};
export type PerformancePage = {
  month: string;
  finalizedAt: string | null;
  model: PerformanceModel;
  departments: { id: string; name: string }[];
  people: PerformancePerson[];
  leaders: RankedEmployee[];
  punctuality: RankedEmployee[];
  employees: RankedEmployee[];
  arrival: (ArrivalRecord & { name: string })[];
  departmentSummary: PerformanceDepartment[];
  trends: PerformanceTrend[];
  assessments: PerformanceAssessment[];
  reviewPeople: PerformancePerson[];
  canConfigure: boolean;
  canFinalize: boolean;
  canExport: boolean;
  canSubmitAssessment: boolean;
  totals: { employees: number; arrival: number; punctuality: number };
  pages: { employees: number; arrival: number; punctuality: number };
  pageSize: number;
};
