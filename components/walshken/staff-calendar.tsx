"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, Filter, MapPin, RefreshCw, Users, X } from "lucide-react";
import { calendarDay, calendarTypes, type CalendarEntry, type CalendarKind, type CalendarMode, type CalendarView, type StaffCalendarData } from "@/lib/walshken/staff-calendar-types";

const modeLabels: Record<CalendarMode, string> = { employee: "My calendar", manager: "Manager calendar", admin: "Admin calendar" };
const viewLabels: Record<CalendarView, string> = { day: "Day", week: "Week", month: "Month" };
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const iso = (day: string) => new Date(day + "T12:00:00Z");
const dayLabel = (day: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" }).format(iso(day));
const shortDay = (day: string) => dayLabel(day, { month: "short", day: "numeric" });
const fullDay = (day: string) => dayLabel(day, { weekday: "long", month: "long", day: "numeric" });
const titleCase = (value: string) => value[0].toUpperCase() + value.slice(1);

function time(stamp: string, zone: string) {
  const effectiveZone = ["America/Edmonton", "Canada/Mountain"].includes(zone) && stamp >= "2026-11-01T00:00:00.000Z" ? "Etc/GMT+6" : zone;
  return new Intl.DateTimeFormat("en-CA", { timeZone: effectiveZone, hour: "numeric", minute: "2-digit" }).format(new Date(stamp));
}
function entryTime(entry: CalendarEntry, zone: string) {
  if (entry.startsAt && entry.endsAt) {
    const start = time(entry.startsAt, zone), end = time(entry.endsAt, zone);
    return entry.startDate === entry.endDate ? start + " – " + end : shortDay(entry.startDate) + " " + start + " – " + shortDay(entry.endDate) + " " + end;
  }
  return entry.startDate === entry.endDate ? "All day" : shortDay(entry.startDate) + " – " + shortDay(entry.endDate);
}
function dateKey(data: StaffCalendarData) {
  const params = new URLSearchParams({ mode: data.mode, view: data.view, anchor: data.anchor });
  if (data.customRange) {
    params.set("from", data.from);
    params.set("to", data.to);
  }
  for (const key of ["department", "country", "employee", "team"] as const) {
    if (data.filters[key]) params.set(key, data.filters[key]);
  }
  if (data.filters.kinds.length) params.set("types", data.filters.kinds.join(","));
  return params;
}

export function StaffCalendar({ data, refresh, setQuery }: { data: StaffCalendarData; refresh: () => void; setQuery: (q: string) => void }) {
  const [focus, setFocus] = useState(data.anchor);
  const [selection, setSelection] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [filterError, setFilterError] = useState("");
  const { from, to, anchor, view, today, zone } = data;
  const focusDay = focus >= from && focus <= to ? focus : anchor >= from && anchor <= to ? anchor : from;
  const focusedEntry = data.entries.find(event => event.id === selection);
  const staffNames = useMemo(() => new Map(data.options.people.map(person => [person.id, person.name])), [data.options.people]);
  const eventsByDay = useMemo(() => {
    const index = new Map<string, CalendarEntry[]>();
    for (const event of data.entries) {
      for (let day = event.startDate > from ? event.startDate : from; day <= event.endDate && day <= to; day = calendarDay(day, 1)) {
        const visible = index.get(day) ?? [];
        visible.push(event);
        index.set(day, visible);
      }
    }
    return index;
  }, [data.entries, from, to]);
  const focusEvents = eventsByDay.get(focusDay) ?? [];
  const availability = data.availability.filter(item => item.from <= focusDay && item.to >= focusDay);
  const days = [];
  for (let day = from; day <= to; day = calendarDay(day, 1)) days.push(day);
  const heading = !data.customRange && view === "month"
    ? dayLabel(anchor, { month: "long", year: "numeric" })
    : from === to ? fullDay(from) : shortDay(from) + " – " + dayLabel(to, { month: "short", day: "numeric", year: "numeric" });
  const activeFilters = Object.values(data.filters).filter(value => typeof value === "string" ? value : value.length).length + Number(data.customRange);

  useEffect(() => {
    function reset() {
      const params = new URLSearchParams(window.location.search);
      setFocus(params.get("anchor") ?? "");
      setSelection("");
      setQuery(params.toString());
    }
    window.addEventListener("popstate", reset);
    return () => window.removeEventListener("popstate", reset);
  }, [setQuery]);

  function navigate(changes: Record<string, string>) {
    const params = dateKey(data);
    for (const [key, value] of Object.entries(changes)) value ? params.set(key, value) : params.delete(key);
    const search = params.toString();
    if (window.location.search.slice(1) !== search) window.history.pushState(null, "", "?" + search);
    setQuery(search);
    setSelection("");
    setFilterError("");
  }

  function setView(next: CalendarView, day = focusDay) {
    setFocus(day);
    navigate({ view: next, anchor: day, from: "", to: "" });
  }

  function step(direction: number) {
    if (data.customRange) {
      const start = calendarDay(from, direction * days.length), end = calendarDay(to, direction * days.length);
      setFocus(start);
      navigate({ from: start, to: end, anchor: start });
      return;
    }
    if (view === "month") {
      const next = iso(anchor.slice(0, 7) + "-01");
      next.setUTCMonth(next.getUTCMonth() + direction);
      const day = next.toISOString().slice(0, 10);
      setView("month", day.slice(0, 7) === today.slice(0, 7) ? today : day);
      return;
    }
    setView(view, calendarDay(anchor, direction * (view === "week" ? 7 : 1)));
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const start = String(values.get("from") ?? ""), end = String(values.get("to") ?? "");
    if ((start || end) && (!start || !end || end < start || Date.parse(end) - Date.parse(start) > 92 * 86_400_000)) {
      setFilterError("Choose both dates and a range of up to 93 days.");
      return;
    }
    if (start) setFocus(start);
    navigate({ department: String(values.get("department") ?? ""), country: String(values.get("country") ?? ""),
      employee: String(values.get("employee") ?? ""), team: String(values.get("team") ?? ""),
      types: values.getAll("type").join(","), from: start, to: end, ...(start ? { anchor: start } : {}) });
    setExpanded(false);
  }

  function resetFilters() {
    navigate({ department: "", country: "", employee: "", team: "", types: "", from: "", to: "" });
  }
  const roster = data.roster.filter(person => (!person.from || person.from <= focusDay) && (!person.to || person.to >= focusDay));
  const gridStart = (iso(from).getUTCDay() + 6) % 7;

  function agendaEvent(event: CalendarEntry) {
    const owners = event.people.map(id => staffNames.get(id)).filter(Boolean);
    return <li key={event.id}><button type="button" className="sc-agenda-event" data-kind={event.kind} onClick={() => setSelection(event.id)}>
      <span className="sc-dot" />
      <span className="sc-event-copy"><strong>{event.title}</strong><small>{entryTime(event, zone)}{data.mode !== "employee" && owners.length ? " · " + owners.join(", ") : ""}</small></span>
      <ChevronRight size={15} aria-hidden="true" />
    </button></li>;
  }

  return <section className="staff-calendar" aria-label="Unified staff calendar">
    <header className="sc-controls">
      <div className="sc-topline">
        <div className="sc-role">
          <span className="sc-calendar-icon"><CalendarDays size={22} aria-hidden="true" /></span>
          <div><h2>{modeLabels[data.mode]}</h2><p>Times shown in {zone.replaceAll("_", " ")}</p></div>
        </div>
        <div className="sc-tools">
          {data.modes.length > 1 && <label className="sc-select-role"><span className="sc-visually-hidden">Calendar scope</span>
            <select value={data.mode} onChange={event => navigate({ mode: event.target.value, department: "", country: "", employee: "", team: "" })}>
              {data.modes.map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}
            </select>
          </label>}
          <button type="button" className="sc-btn" aria-expanded={expanded} aria-controls="staff-calendar-filters" onClick={() => setExpanded(!expanded)}>
            <Filter size={16} aria-hidden="true" /> Filters{activeFilters > 0 && <span className="sc-filter-count">{activeFilters}</span>}
          </button>
          <button type="button" className="sc-btn sc-icon-btn" aria-label="Refresh calendar" onClick={refresh}><RefreshCw size={16} /></button>
        </div>
      </div>
      <div className="sc-toolbar">
        <div className="sc-date-controls">
          <button type="button" className="sc-btn sc-icon-btn" aria-label="Previous calendar period" onClick={() => step(-1)}><ChevronLeft size={18} /></button>
          <button type="button" className="sc-btn sc-icon-btn" aria-label="Next calendar period" onClick={() => step(1)}><ChevronRight size={18} /></button>
          <button type="button" className="sc-btn" onClick={() => setView(view, today)}>Today</button>
        </div>
        <h3 aria-live="polite">{heading}</h3>
        <div className="sc-segment" aria-label="Calendar layout">
          {(["day", "week", "month"] as const).map(option => <button key={option} type="button" aria-pressed={view === option && !data.customRange} onClick={() => setView(option)}>{viewLabels[option]}</button>)}
        </div>
      </div>
    </header>

    {expanded && <form id="staff-calendar-filters" className="sc-filters" key={dateKey(data).toString()} onSubmit={apply}>
      <div className="sc-filter-grid">
        <label>Department<select name="department" defaultValue={data.filters.department}><option value="">All departments</option>{data.options.departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Country<select name="country" defaultValue={data.filters.country}><option value="">All countries</option>{data.options.countries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Employee<select name="employee" defaultValue={data.filters.employee}><option value="">All authorized staff</option>{data.options.people.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Team<select name="team" defaultValue={data.filters.team}><option value="">All teams</option>{data.options.teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>From<input type="date" name="from" min="1900-01-01" max="2199-12-31" defaultValue={data.customRange ? from : ""} /></label>
        <label>Through<input type="date" name="to" min="1900-01-01" max="2199-12-31" defaultValue={data.customRange ? to : ""} /></label>
      </div>
      <fieldset><legend>Event types <span>All types are shown when none are selected.</span></legend>
        <div className="sc-type-filters">{(Object.keys(calendarTypes) as CalendarKind[]).filter(kind => data.mode !== "employee" || !["absence", "approval", "busy"].includes(kind)).map(kind =>
          <label key={kind} data-kind={kind}><input type="checkbox" name="type" value={kind} defaultChecked={data.filters.kinds.includes(kind)} /><span className="sc-dot" />{calendarTypes[kind]}</label>)}</div>
      </fieldset>
      {filterError && <p role="alert" className="sc-filter-error">{filterError}</p>}
      <div className="sc-filter-actions"><button className="sc-btn" type="button" onClick={resetFilters}>Clear filters</button><button className="sc-btn sc-primary" type="submit">Apply filters</button></div>
    </form>}

    {data.holidaySetupNeeded > 0 && <p className="sc-setup">{data.mode === "employee" ? "Your Canadian holiday calendar needs an assignment." : `${data.holidaySetupNeeded} Canadian staff ${data.holidaySetupNeeded === 1 ? "member needs" : "members need"} a holiday calendar assignment.`}
      {" "}<a href={data.mode === "admin" ? "/staff/holidays" : "/staff/holiday-calendar"}>View holiday calendar <ArrowUpRight size={12} /></a></p>}

    <div className={"sc-layout" + (view === "day" && !data.customRange ? " sc-single" : "")}>
      {(view !== "day" || data.customRange) && <div className={"sc-grid sc-" + (data.customRange ? "range" : view)}>
        <div className="sc-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
        <div className="sc-dates">
          {data.customRange && Array.from({ length: gridStart }, (_, index) => <div className="sc-date sc-blank" aria-hidden="true" key={"blank" + index} />)}
          {days.map(day => {
            const items = eventsByDay.get(day) ?? [];
            const limit = view === "week" && !data.customRange ? 7 : 3;
            return <div key={day} className={["sc-date", day === focusDay ? "sc-selected" : "", day === today ? "sc-today" : "",
              view === "month" && !data.customRange && day.slice(0, 7) !== anchor.slice(0, 7) ? "sc-outside" : ""].join(" ")}>
              <button className="sc-date-number" type="button" aria-pressed={day === focusDay} aria-current={day === today ? "date" : undefined}
                aria-label={`${fullDay(day)}, ${items.length} ${items.length === 1 ? "event" : "events"}`} onClick={() => { setFocus(day); setSelection(""); }}>{Number(day.slice(-2))}</button>
              <div className="sc-date-events">{items.slice(0, limit).map(item => <button key={item.id} data-kind={item.kind} className="sc-chip" type="button"
                onClick={() => { setFocus(day); setSelection(item.id); }} title={item.title}><span className="sc-dot" />{item.startsAt && item.startDate === day && view === "week" && <small>{time(item.startsAt, zone)}</small>}<span>{item.title}</span></button>)}
                {items.length > limit && <button type="button" className="sc-more" onClick={() => { setFocus(day); setSelection(""); }}>+{items.length - limit} more</button>}</div>
              {items.length > 0 && <div className="sc-mobile-dots" aria-hidden="true">{[...new Set(items.map(item => item.kind))].slice(0, 4).map(kind => <span key={kind} className="sc-dot" data-kind={kind} />)}</div>}
            </div>;
          })}
        </div>
      </div>}
      <aside className="sc-side" aria-label="Selected day and staff availability">
        <section className="sc-panel">
          <div className="sc-panel-head"><div><p>Day agenda</p><h3>{fullDay(focusDay)}</h3></div>
            {(view !== "day" || data.customRange) && <button className="sc-btn sc-icon-btn" type="button" aria-label="Open day view" onClick={() => setView("day")}><ArrowUpRight size={17} /></button>}
          </div>
          {focusedEntry && <div className="sc-detail" data-kind={focusedEntry.kind}>
            <div className="sc-detail-head"><span><span className="sc-dot" />{calendarTypes[focusedEntry.kind]}</span><button className="sc-btn sc-icon-btn" type="button" aria-label="Close event details" onClick={() => setSelection("")}><X size={16} /></button></div>
            <h4>{focusedEntry.title}</h4>
            <p><Clock3 size={15} /> {entryTime(focusedEntry, zone)}</p>
            {focusedEntry.location && <p><MapPin size={15} /> {focusedEntry.location}</p>}
            {data.mode !== "employee" && <p><Users size={15} /> {focusedEntry.people.map(id => staffNames.get(id)).filter(Boolean).join(", ")}</p>}
            {focusedEntry.status && <p className="sc-detail-status">{focusedEntry.status}</p>}
            {focusedEntry.href && <a className="sc-btn sc-primary" href={focusedEntry.href}>Open source <ArrowUpRight size={15} /></a>}
          </div>}
          {focusEvents.length ? <ul className="sc-agenda">{focusEvents.map(agendaEvent)}</ul> : <p className="sc-empty">No events match this day.</p>}
        </section>

        {data.mode !== "employee" && <section className="sc-panel">
          <div className="sc-panel-head"><div><p>Schedule overview</p><h3>Staff availability</h3></div><Users size={18} aria-hidden="true" /></div>
          {roster.length ? <ul className="sc-roster">{roster.map(person => {
            const statuses = [...new Set(availability.filter(item => item.person === person.id).map(item => item.status))];
            return <li key={person.id}><strong>{person.name}</strong><div>{(statuses.length ? statuses : ["no published shift"]).map(status => <span className="sc-status" data-status={status} key={status}>{titleCase(status)}</span>)}</div></li>;
          })}</ul> : <p className="sc-empty">No staff match these filters.</p>}
        </section>}
      </aside>
    </div>
  </section>;
}
