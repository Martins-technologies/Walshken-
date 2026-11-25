"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "./brand";
import { api, dateText, Status } from "./ui";
import styles from "./communication-management.module.css";

export const communicationManagementDialogClass = styles.dialog;

type Access = {
  directory: boolean;
  metadata: boolean;
  reports: boolean;
  content: boolean;
  employeeVisibility: boolean;
  teamVisibility: boolean;
  policy: boolean;
};
type DirectoryEmployee = {
  id: string;
  name: string;
  title: string | null;
  status: string;
  department: string | null;
  departments: string | null;
  hidden: boolean;
  department_hidden: boolean;
  team_hidden?: boolean;
  last_activity: string | null;
  can_edit: boolean;
};
type Conversation = {
  id: string;
  title: string;
  kind: string;
  status: string;
  last_activity: string | null;
  participants: string | null;
  participant_count?: number;
  can_read: boolean;
};
type Activity = {
  id: string;
  name: string;
  department: string | null;
  conversations: number;
  messages: number;
  last_activity: string | null;
};
type DirectoryScope = { id: string; name: string; hidden: boolean; can_edit: boolean };
type Department = DirectoryScope & { support: boolean };
type ResultPage = { total: number; page: number; pageSize: number };
type Oversight = ResultPage & {
  access: Access;
  directory?: DirectoryEmployee[];
  conversations?: Conversation[];
  activity?: Activity[];
  departments: Department[];
  teams: DirectoryScope[];
};
type Review = ResultPage & {
  title: string;
  rows: { id: string; name: string; body: string; created_at: string }[];
};
type Section = "directory" | "conversations" | "activity" | "visibility" | "content";
type Filters = { query: string; department: string; team: string };
type Request = { section: Section; page: number; filters: Filters; revision: number };
type ReviewTarget = Pick<Conversation, "id" | "title">;
type VisibilityKind = "employee" | "department" | "team";

const sections: { id: Section; label: string; icon: string; allowed: (access: Access) => boolean }[] = [
  { id: "directory", label: "Employees", icon: "users", allowed: access => access.directory || access.employeeVisibility },
  { id: "conversations", label: "Conversations", icon: "message", allowed: access => access.metadata },
  { id: "activity", label: "Activity", icon: "chart", allowed: access => access.reports },
  { id: "visibility", label: "Visibility settings", icon: "settings", allowed: access => access.teamVisibility || access.policy },
  { id: "content", label: "Review messages", icon: "lock", allowed: access => access.content && !access.metadata },
];
const emptyFilters = { query: "", department: "", team: "" };
const defaultRequest: Request = { section: "directory", page: 1, filters: emptyFilters, revision: 0 };
const number = new Intl.NumberFormat("en");
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function PageControls({ data, busy, onPage }: { data: ResultPage; busy: boolean; onPage: (page: number) => void }) {
  const pages = data.pageSize > 0 ? Math.min(500, Math.max(1, Math.ceil(data.total / data.pageSize))) : 1;
  if (pages === 1 && data.page === 1) return null;
  return <nav className={styles.pages} aria-label="Results pages">
    <button className="btn btn-outline btn-small" type="button" disabled={busy || data.page <= 1} onClick={() => onPage(data.page - 1)}>
      <Icon name="previous" size={15} /> Previous
    </button>
    <span aria-live="polite">{data.page > pages ? `Page ${data.page}` : `Page ${data.page} of ${pages}`}</span>
    <button className="btn btn-outline btn-small" type="button" disabled={busy || data.page >= pages} onClick={() => onPage(data.page + 1)}>
      Next <Icon name="next" size={15} />
    </button>
  </nav>;
}

type Column<Row> = { label: string; render: (row: Row) => ReactNode };

function ManagementTable<Row extends { id: string }>({ label, rows, columns, empty }: {
  label: string;
  rows: Row[];
  columns: Column<Row>[];
  empty: string;
}) {
  if (!rows.length) return <p className={styles.empty}>{empty}</p>;
  return <div className={styles.tableWrap}>
    <table className={styles.table} aria-label={label} role="table">
      <thead role="rowgroup"><tr role="row">{columns.map(column => <th key={column.label} scope="col" role="columnheader">{column.label}</th>)}</tr></thead>
      <tbody role="rowgroup">{rows.map(row => <tr key={row.id} role="row">
        {columns.map((column, index) => index === 0
          ? <th key={column.label} scope="row" role="rowheader">{column.render(row)}</th>
          : <td key={column.label} role="cell"><span className={styles.cellLabel} aria-hidden="true">{column.label}</span><span>{column.render(row)}</span></td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

function LastActivity({ raw, timeZone }: { raw: string | null; timeZone: string }) {
  return raw ? <time dateTime={raw}>{dateText(raw, true, timeZone)}</time> : <span className={styles.muted}>—</span>;
}

function DirectoryStatus({ employee }: { employee: DirectoryEmployee }) {
  const reasons = [
    employee.hidden && "Hidden directly",
    employee.department_hidden && "Hidden by department",
    employee.team_hidden && "Hidden by team",
  ].filter(Boolean);
  return reasons.length
    ? <div className={styles.tags}>{reasons.map(reason => <Status key={String(reason)}>{reason}</Status>)}</div>
    : <Status>Visible</Status>;
}

function VisibilityButton({ kind, scope, busy, onChange }: {
  kind: VisibilityKind;
  scope: Pick<DirectoryScope, "id" | "name" | "hidden">;
  busy: boolean;
  onChange: (kind: VisibilityKind, scope: Pick<DirectoryScope, "id" | "name" | "hidden">) => void;
}) {
  const action = scope.hidden ? "Restore" : "Hide";
  return <button
    className="btn btn-outline btn-small"
    type="button"
    aria-label={`${action} ${kind} ${scope.name}`}
    disabled={busy}
    onClick={() => onChange(kind, scope)}
  >{action} {kind}</button>;
}

function ReviewContent({ target, timeZone, onClose }: { target?: ReviewTarget; timeZone: string; onClose?: () => void }) {
  const [conversation, setConversation] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const auditNote = useId();

  useEffect(() => { heading.current?.focus(); }, [result?.title]);

  function conversationId() {
    if (target) return target.id;
    const input = conversation.trim();
    try { return new URL(input, window.location.origin).searchParams.get("conversation") ?? input; }
    catch { return input; }
  }

  async function openContent(page: number) {
    if (busy) return;
    const id = conversationId();
    if (reason.trim().length < 8) {
      setError("Enter an access reason of at least eight characters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await api("messages/oversight-content", { conversation: id, reason: reason.trim(), page }) as Review;
      setResult(response);
    } catch (failure) {
      setResult(null);
      setError(errorMessage(failure, "Unable to review message content."));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void openContent(1);
  }

  return <section className={styles.review} aria-label="Message content review" aria-busy={busy}>
    <div className={styles.reviewHeading}>
      <h3 ref={heading} tabIndex={-1}>{result?.title || target?.title || "Review messages"}</h3>
      {onClose
        ? <button type="button" className="btn btn-outline btn-small" onClick={onClose}>Back to conversations</button>
        : result && <button type="button" className="btn btn-outline btn-small" onClick={() => {
          setResult(null);
          setConversation("");
          setReason("");
        }} disabled={busy}>Start a new review</button>}
    </div>
    <p className={styles.notice} id={auditNote}><Icon name="shield" size={17} /> Message content access is recorded in the audit log with your reason.</p>
    {!result && <form className={styles.reviewForm} onSubmit={submit}>
      {!target && <label>Conversation ID or Messages link<input type="text" required value={conversation} maxLength={350} spellCheck={false} onChange={event => setConversation(event.target.value)} disabled={busy} /></label>}
      <label>Reason for access
        <textarea required minLength={8} maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} aria-describedby={auditNote} disabled={busy} />
      </label>
      <button className="btn btn-blue btn-small" disabled={busy || !target && !conversation.trim()}>
        <Icon name="lock" size={16} /> {busy ? "Opening…" : "View message content"}
      </button>
    </form>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {result && <>
      {result.rows.length ? <ol className={styles.messageList} aria-label="Message content" aria-busy={busy}>
        {result.rows.map(row => <li key={row.id}>
          <div><strong>{row.name}</strong> <time dateTime={row.created_at}>{dateText(row.created_at, true, timeZone)}</time></div>
          <p>{row.body || "No message text"}</p>
        </li>)}
      </ol> : <p className={styles.empty}>No message content to review.</p>}
      <PageControls data={result} busy={busy} onPage={page => void openContent(page)} />
    </>}
    {busy && <p className="sr-only" role="status">Loading message content…</p>}
  </section>;
}

export function CommunicationManagement({ timeZone, onVisibilityChange }: { timeZone: string; onVisibilityChange?: () => void }) {
  const [request, setRequest] = useState<Request>(defaultRequest);
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [response, setResponse] = useState<{ request: Request; data: Oversight } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const reviewTriggerPrefix = useId();
  const filterPrefix = useId();
  const { section, filters } = request;
  const access = response?.data.access;
  const available = access ? sections.filter(item => item.allowed(access)) : [];
  const data = response?.request.section === section && response.request.filters === filters
    ? response.data : null;
  const waiting = section !== "content" && (loading || !loadError && response?.request !== request);
  const busy = saving || waiting;

  useEffect(() => {
    if (request.section === "content") return;
    let active = true;
    setLoading(true);
    setLoadError("");
    const serverSection = request.section === "visibility" ? "directory" : request.section;
    api("messages/oversight", { section: serverSection, ...request.filters, page: request.page })
      .then((result: Oversight) => {
        if (!active) return;
        setResponse({ request, data: result });
        const allowed = sections.filter(item => item.allowed(result.access));
        if (allowed.length && !allowed.some(item => item.id === request.section)) {
          setDraft(emptyFilters);
          setRequest({ ...defaultRequest, section: allowed[0].id });
        }
      })
      .catch((failure: unknown) => { if (active) setLoadError(errorMessage(failure, "Unable to load communication management.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request]);

  function navigate(next: Section) {
    setReview(null);
    if (section === next) return;
    setFeedback(null);
    setDraft(emptyFilters);
    setRequest({ ...defaultRequest, section: next });
  }

  function closeReview() {
    const trigger = review && `${reviewTriggerPrefix}-${review.id}`;
    setReview(null);
    if (trigger) requestAnimationFrame(() => document.getElementById(trigger)?.focus());
  }

  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setRequest(previous => ({ ...previous, filters: { ...draft, query: draft.query.trim() }, page: 1 }));
  }

  function reload() {
    setRequest(previous => ({ ...previous, revision: previous.revision + 1 }));
  }

  async function save(path: string, payload: Record<string, unknown>, message: string, refreshDirectory: boolean) {
    if (busy) return;
    setSaving(true);
    setFeedback(null);
    try {
      await api(path, payload);
      setFeedback({ text: message, error: false });
      reload();
      if (refreshDirectory) onVisibilityChange?.();
    } catch (failure) {
      setFeedback({ text: errorMessage(failure, "Unable to save communication settings."), error: true });
    } finally {
      setSaving(false);
    }
  }

  function changeVisibility(kind: VisibilityKind, scope: Pick<DirectoryScope, "id" | "name" | "hidden">) {
    void save("messages/directory-visibility", { kind, target: scope.id, hidden: !scope.hidden },
      scope.hidden ? `Directory visibility setting restored for ${scope.name}.` : `${scope.name} was hidden from the directory.`, true);
  }

  const directoryColumns: Column<DirectoryEmployee>[] = [
    { label: "Employee", render: row => <>{row.name}{row.title && <small>{row.title}</small>}</> },
    { label: "Departments", render: row => row.departments || row.department || "Unassigned" },
    { label: "Status", render: row => <Status>{row.status}</Status> },
    { label: "Directory visibility", render: row => <DirectoryStatus employee={row} /> },
  ];
  if (access?.reports) directoryColumns.push({
    label: "Last activity", render: row => <LastActivity raw={row.last_activity} timeZone={timeZone} />,
  });
  if (access?.employeeVisibility) directoryColumns.push({
    label: "Actions", render: row => row.can_edit && <VisibilityButton kind="employee" scope={row} busy={busy} onChange={changeVisibility} />,
  });

  const conversationColumns: Column<Conversation>[] = [
    { label: "Conversation", render: row => <>{row.title}<small>{row.kind === "Direct" ? "Direct message" : row.kind}</small></> },
    { label: "Participants", render: row => row.participants || (row.participant_count == null ? "—" : number.format(row.participant_count)) },
    { label: "Status", render: row => <Status>{row.status}</Status> },
    { label: "Last activity", render: row => <LastActivity raw={row.last_activity} timeZone={timeZone} /> },
  ];
  if (access?.content) conversationColumns.push({
    label: "Message content", render: row => row.can_read
      ? <button className="btn btn-outline btn-small" type="button" id={`${reviewTriggerPrefix}-${row.id}`} disabled={busy}
        aria-label={`Review messages in ${row.title}`} onClick={() => setReview(row)}><Icon name="lock" size={15} /> Review messages</button>
      : <span className={styles.muted}>Restricted</span>,
  });

  const activityColumns: Column<Activity>[] = [
    { label: "Employee", render: row => row.name },
    { label: "Departments", render: row => row.department || "Unassigned" },
    { label: "Active conversations", render: row => number.format(row.conversations) },
    { label: "Messages retained", render: row => number.format(row.messages) },
    { label: "Last activity", render: row => <LastActivity raw={row.last_activity} timeZone={timeZone} /> },
  ];
  const departmentColumns: Column<Department>[] = [
    { label: "Department", render: row => row.name },
    { label: "Directory visibility", render: row => <Status>{row.hidden ? "Hidden" : "Visible"}</Status> },
  ];
  if (access?.teamVisibility) departmentColumns.push({
    label: "Actions", render: row => row.can_edit && <VisibilityButton kind="department" scope={row} busy={busy} onChange={changeVisibility} />,
  });
  if (access?.policy) departmentColumns.push({
    label: "Organization-wide Support messaging",
    render: row => <div className={styles.supportControl}>
      <Status>{row.support ? "Enabled" : "Disabled"}</Status>
      <button className="btn btn-outline btn-small" type="button" disabled={busy}
        aria-label={`${row.support ? "Disable" : "Enable"} Support messaging for ${row.name}`}
        onClick={() => void save("messages/communication-support", { department: row.id, enabled: !row.support },
          `Support messaging ${row.support ? "disabled" : "enabled"} for ${row.name}.`, true)}
      >{row.support ? "Disable" : "Enable"}</button>
    </div>,
  });
  const teamColumns: Column<DirectoryScope>[] = [
    { label: "Team", render: row => row.name },
    { label: "Directory visibility", render: row => <Status>{row.hidden ? "Hidden" : "Visible"}</Status> },
    { label: "Actions", render: row => row.can_edit && <VisibilityButton kind="team" scope={row} busy={busy} onChange={changeVisibility} /> },
  ];

  return <section className={styles.management} aria-label="Communication oversight">
    {available.length > 0 && <nav className={styles.tabs} aria-label="Communication management sections">
      {available.map(item => <button key={item.id} type="button" aria-pressed={section === item.id} disabled={saving} onClick={() => navigate(item.id)}>
        <Icon name={item.icon} size={17} /> {item.label}
      </button>)}
    </nav>}
    {section === "content" && access?.content
      ? <ReviewContent timeZone={timeZone} />
      : review && access?.content
        ? <ReviewContent key={review.id} target={review} timeZone={timeZone} onClose={closeReview} />
        : <>
          {available.some(item => item.id === section) && section !== "visibility" && <form className={styles.filters} onSubmit={filter}>
            <div className={styles.filterField}>
              <label htmlFor={`${filterPrefix}-query`}>{section === "conversations" ? "Conversation or participant" : "Employee name"}</label>
              <input id={`${filterPrefix}-query`} type="search" value={draft.query} maxLength={100} onChange={event => setDraft(previous => ({ ...previous, query: event.target.value }))} />
            </div>
            <div className={styles.filterField}>
              <label htmlFor={`${filterPrefix}-department`}>Department</label>
              <select id={`${filterPrefix}-department`} value={draft.department} onChange={event => setDraft(previous => ({ ...previous, department: event.target.value }))}>
                <option value="">All departments</option>
                {response?.data.departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
              </select>
            </div>
            <div className={styles.filterField}>
              <label htmlFor={`${filterPrefix}-team`}>Team</label>
              <select id={`${filterPrefix}-team`} value={draft.team} onChange={event => setDraft(previous => ({ ...previous, team: event.target.value }))}>
                <option value="">All teams</option>
                {response?.data.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn-outline btn-small" disabled={saving}><Icon name="search" size={16} /> Search</button>
          </form>}
          {feedback && <p className={feedback.error ? "form-error" : "form-success"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
          {loadError && <div className={styles.loadError}>
            <p className="form-error" role="alert">{loadError}</p>
            <button className="btn btn-outline btn-small" type="button" onClick={reload}>Retry</button>
          </div>}
          {waiting && <p className={data ? "sr-only" : styles.empty} role="status">Loading communication records…</p>}
          {!waiting && !loadError && access && !available.length && <p className={styles.empty}>You do not have access to communication management.</p>}
          {data && !loadError && available.some(item => item.id === section) && <div className={styles.results} aria-busy={busy}>
            {section === "directory" && <ManagementTable label="Employee communication directory" rows={data.directory ?? []} columns={directoryColumns} empty="No employees match your search." />}
            {section === "conversations" && <ManagementTable label="Conversation metadata" rows={data.conversations ?? []} columns={conversationColumns} empty="No conversations match your search." />}
            {section === "activity" && <ManagementTable label="Communication activity" rows={data.activity ?? []} columns={activityColumns} empty="No employee activity matches your search." />}
            {section === "visibility" && <>
              <p className={styles.notice}><Icon name="users" size={17} /> Directory visibility controls who appears in new-message searches. Message content requires separate permission.</p>
              <div className={styles.settingsGroup}>
                <h3>Departments</h3>
                <ManagementTable label="Department settings" rows={data.departments} columns={departmentColumns} empty="No departments are available in your scope." />
              </div>
              {access?.teamVisibility && <div className={styles.settingsGroup}>
                <h3>Teams</h3>
                <ManagementTable label="Team settings" rows={data.teams} columns={teamColumns} empty="No teams are available in your scope." />
              </div>}
            </>}
            {section !== "visibility" && <PageControls data={data} busy={busy} onPage={next => setRequest(previous => ({ ...previous, page: next }))} />}
          </div>}
        </>}
  </section>;
}
