import { formatAppointmentTime } from "./client-appointment-time";
import { clientCaseFor, notifyCaseStaff, recordCaseEvent, staffCaseFor, type ClientCase } from "./client-cases";
import { startClientCall, type CallViewer } from "./client-calls";
import { notifyClient } from "./client-notifications";
import { privateCalendarFile } from "./private-calendar";
import { scheduledMeetingTime } from "./meeting-invitations";
import { all, audit, fail, id, integer, json, now, one, pick, run, str, timeZone, type Db } from "./server";

type Mode = "Audio" | "Video";
type Slot = {
  id:string; org_id:string; employee_id:string; starts_at:string; ends_at:string;
  time_zone:string; mode:Mode; published:boolean; occupied:boolean;
};
type Appointment = {
  id:string; org_id:string; case_id:string; customer_id:string; employee_id:string; slot_id:string;
  representative_name:string; starts_at:string; ends_at:string; time_zone:string;
  mode:Mode; status:"Booked"|"Cancelled"|"Completed"; revision:number;
};
type EventName = "Booked"|"Rescheduled"|"Cancelled"|"Completed"|"Join opened"|"Reminder 24h"|"Reminder 1h";

const minute = 60_000;
const joinLead = 10 * minute;
const currentBookingHours = 24 * 90;
const slotFields = "id,org_id,employee_id,starts_at,ends_at,time_zone,mode,published,occupied";
const appointmentFields = "id,org_id,case_id,customer_id,employee_id,slot_id,representative_name,starts_at,ends_at,time_zone,mode,status,revision";
const clientHref = (caseId:string, appointmentId?:string) =>
  `/customer/appointments?case=${encodeURIComponent(caseId)}${appointmentId ? `&appointment=${encodeURIComponent(appointmentId)}` : ""}`;
const plus = (stamp:string, delta:number) => new Date(Date.parse(stamp) + delta).toISOString();
const matchesAssignment = (item:Appointment, row:ClientCase) => item.employee_id === row.assigned_employee_id;
const joinWindow = (item:Appointment, stamp:string) =>
  item.status === "Booked" && stamp >= plus(item.starts_at,-joinLead) && stamp < item.ends_at;

function caseFor(db:Db, viewer:CallViewer, caseId:string, lock=false) {
  return viewer.side === "client" ? clientCaseFor(db,viewer.id,caseId,lock) : staffCaseFor(db,viewer.actor,caseId,lock);
}

function bookableCase(row:ClientCase) {
  return Boolean(row.assigned_employee_id && row.communication_enabled && !["Complete","Closed"].includes(row.client_status) &&
    row.representative_name.trim().length >= 2 && !row.representative_name.includes("@") && !/\d[\d ()+.-]{6,}\d/.test(row.representative_name));
}

async function activeHost(db:Db, org:string, host:string) {
  return one<{id:string}>(db,`SELECT id FROM employees WHERE id=? AND org_id=? AND status='Active'
    AND employment_status<>'Ended' AND role<>'guest'`,host,org);
}

function appointmentDto(row:ClientCase, item:Appointment, viewer:CallViewer, stamp:string) {
  return {
    id:item.id,caseId:item.case_id,representative:item.representative_name,
    startsAt:item.starts_at,endsAt:item.ends_at,timeZone:item.time_zone,mode:item.mode,revision:item.revision,
    status:item.status==="Booked" && stamp>=item.ends_at ? "Past" : item.status,
    canChange:item.status==="Booked" && stamp<item.starts_at,
    canComplete:viewer.side==="staff" && item.status==="Booked" && stamp>=item.ends_at,
    canJoin:bookableCase(row) && matchesAssignment(item,row) && joinWindow(item,stamp) &&
      (viewer.side==="client" || viewer.id===item.employee_id),
  };
}

function staffCalendarCollision(db:Db, org:string, employee:string, starts:string, ends:string) {
  return one(db,`SELECT m.id FROM meetings m WHERE m.org_id=? AND m.cancelled_at IS NULL AND m.ended_at IS NULL
    AND m.starts_at < ? AND m.ends_at > ? AND (m.organizer_id=? OR EXISTS (
      SELECT 1 FROM meeting_members p WHERE p.meeting_id=m.id AND p.employee_id=? AND p.removed_at IS NULL)) LIMIT 1`,
    org,ends,starts,employee,employee);
}

export async function clientAppointments(db:Db, viewer:CallViewer, caseId:string, summary=false) {
  const row = await caseFor(db,viewer,caseId);
  const stamp=now(), staff=viewer.side==="staff";
  const host=row.assigned_employee_id;
  const canSchedule=bookableCase(row) && host!==null && Boolean(await activeHost(db,row.org_id,host));
  const [appointments, slots] = await Promise.all([
    all<Appointment>(db,`SELECT ${appointmentFields} FROM client_appointments WHERE org_id=? AND case_id=? AND customer_id=?
      ${summary ? "AND status='Booked' AND ends_at>?" : ""}
      ORDER BY CASE WHEN status='Booked' AND ends_at>? THEN 0 ELSE 1 END,
        CASE WHEN status='Booked' AND ends_at>? THEN starts_at END ASC, starts_at DESC,id LIMIT ${summary ? 1 : 70}`,
      row.org_id,row.id,row.customer_id,...(summary?[stamp]:[]),stamp,stamp),
    summary || !canSchedule ? [] : all<Slot>(db,`SELECT ${slotFields} FROM client_appointment_slots s
      WHERE s.org_id=? AND s.employee_id=? AND s.starts_at>? AND s.published
        ${staff ? "" : `AND NOT s.occupied
          AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.org_id=s.org_id AND m.cancelled_at IS NULL AND m.ended_at IS NULL
          AND m.starts_at<s.ends_at AND m.ends_at>s.starts_at AND (m.organizer_id=s.employee_id OR EXISTS (
          SELECT 1 FROM meeting_members member WHERE member.meeting_id=m.id AND member.employee_id=s.employee_id AND member.removed_at IS NULL)))`}
      ORDER BY s.starts_at,s.id LIMIT 100`,row.org_id,host,stamp),
  ]);
  return json({appointments:appointments.map(item=>appointmentDto(row,item,viewer,stamp)),
    slots:slots.map(item=>({id:item.id,startsAt:item.starts_at,endsAt:item.ends_at,timeZone:item.time_zone,mode:item.mode,occupied:item.occupied})),
    representative:canSchedule ? row.representative_name : null,canSchedule,canManageAvailability:staff && canSchedule,
  });
}

async function event(db:Db,item:Appointment,action:EventName,staffActor:string|null,reference:string|null=null) {
  return run(db,`INSERT INTO client_appointment_events(id,org_id,appointment_id,customer_id,staff_actor_id,event,reference,created_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,id(),item.org_id,item.id,item.customer_id,staffActor,action,reference,now());
}

function appointmentNotice(db:Db,item:Appointment,action:EventName,title:string) {
  return notifyClient(db,item.customer_id,{type:"appointment",title,
    body:`${title} for ${formatAppointmentTime(item.starts_at,item.ends_at,item.time_zone,"en")} (${item.time_zone}).`,
    href:clientHref(item.case_id,item.id),dedupeKey:`appointment:${item.id}:${item.revision}:${action}`});
}

async function lockParticipants(db:Db, row:ClientCase, extraHost?:string) {
  const hosts=[...new Set([row.assigned_employee_id,extraHost].filter((value):value is string=>!!value))].sort();
  for (const host of hosts) await one(db,"SELECT id FROM employees WHERE org_id=? AND id=? FOR UPDATE",row.org_id,host);
  await one(db,"SELECT id FROM customers WHERE id=? FOR UPDATE",row.customer_id);
}

async function newSlot(db:Db,viewer:CallViewer,row:ClientCase,data:Record<string,unknown>) {
  if (viewer.side!=="staff") return fail(403,"Only the company can publish availability.");
  if (!bookableCase(row) || !row.assigned_employee_id) return fail(409,"Assign an active representative and enable communication before publishing availability.");
  const zone=timeZone(data.timeZone),duration=integer(data.duration,"appointment minutes",15,120);
  const mode=pick(data.mode,["Audio","Video"] as const,"call format");
  const starts=scheduledMeetingTime(str(data.localStart,"start time",16),"appointment start time",zone);
  const stamp=now(), ends=plus(starts,duration*minute);
  if (starts<=stamp || starts>plus(stamp,currentBookingHours*60*minute)) return fail(400,"Publish availability within the next 90 days.");
  const host=row.assigned_employee_id;
  await one(db,"SELECT id FROM employees WHERE org_id=? AND id=? FOR UPDATE",row.org_id,host);
  if (!await activeHost(db,row.org_id,host)) return fail(409,"The assigned representative is inactive.");
  const overlap=await one(db,`SELECT id FROM client_appointment_slots WHERE org_id=? AND employee_id=? AND published
    AND starts_at<? AND ends_at>? LIMIT 1`,row.org_id,host,ends,starts);
  if (overlap || await staffCalendarCollision(db,row.org_id,host,starts,ends)) return fail(409,"This time overlaps an existing appointment slot or staff meeting.");
  const slot=id();
  await run(db,`INSERT INTO client_appointment_slots(id,org_id,employee_id,published_by,starts_at,ends_at,time_zone,mode,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`,slot,row.org_id,host,viewer.id,starts,ends,zone,mode,stamp);
  await audit(db,viewer.actor,"Published client appointment availability","Client appointment slot",slot).run();
  return json({id:slot},201);
}

async function unpublishSlot(db:Db,viewer:CallViewer,row:ClientCase,rawId:unknown) {
  if (viewer.side!=="staff") return fail(403,"Only the company can withdraw availability.");
  const slotId=str(rawId,"appointment slot",80);
  if (!row.assigned_employee_id) return fail(404,"This slot is outside the current case assignment.");
  await one(db,"SELECT id FROM employees WHERE org_id=? AND id=? FOR UPDATE",row.org_id,row.assigned_employee_id);
  const changed=await run(db,`UPDATE client_appointment_slots SET published=false
    WHERE id=? AND org_id=? AND employee_id=? AND published AND NOT occupied AND starts_at>?`,
    slotId,row.org_id,row.assigned_employee_id,now());
  if (!changed.count) return fail(409,"This slot is booked, withdrawn, or outside the current assignment.");
  await audit(db,viewer.actor,"Withdrew unused client appointment availability","Client appointment slot",slotId).run();
  return json({ok:true});
}

async function appointmentById(db:Db,row:ClientCase,key:string,lock=false) {
  const item=await one<Appointment>(db,`SELECT ${appointmentFields} FROM client_appointments
    WHERE org_id=? AND case_id=? AND customer_id=? AND id=? ${lock?"FOR UPDATE":""}`,row.org_id,row.id,row.customer_id,key);
  if (!item) return fail(404,"This appointment is unavailable.");
  return item;
}

async function reserveSlot(db:Db,row:ClientCase, data:Record<string,unknown>, previous?:Appointment) {
  if (!bookableCase(row) || !row.assigned_employee_id) return fail(409,"Appointment booking needs an assigned representative with communication enabled.");
  const key=str(data.slot,"appointment slot",80);
  const target=await one<Slot>(db,`SELECT ${slotFields} FROM client_appointment_slots
    WHERE id=? AND org_id=? AND employee_id=? AND published AND NOT occupied AND starts_at>? FOR UPDATE`,
    key,row.org_id,row.assigned_employee_id,now());
  if (!target || !await activeHost(db,row.org_id,row.assigned_employee_id)) return fail(409,"This time is no longer available. Choose another slot.");
  const conflict=await one(db,`SELECT id FROM client_appointments WHERE org_id=? AND customer_id=? AND status='Booked' AND id<>?
    AND starts_at<? AND ends_at>? LIMIT 1`,row.org_id,row.customer_id,previous?.id ?? "",target.ends_at,target.starts_at);
  if (conflict || await staffCalendarCollision(db,row.org_id,row.assigned_employee_id,target.starts_at,target.ends_at)) {
    return fail(409,"This time conflicts with an existing booking. Choose another slot.");
  }
  const claimed=await run(db,"UPDATE client_appointment_slots SET occupied=true WHERE org_id=? AND id=? AND NOT occupied",row.org_id,target.id);
  if (!claimed.count) return fail(409,"This time was just booked. Choose another slot.");
  return target;
}

async function clearSlot(db:Db,item:Appointment) {
  await run(db,"UPDATE client_appointment_slots SET occupied=false WHERE id=? AND org_id=? AND employee_id=?",item.slot_id,item.org_id,item.employee_id);
}

type AppointmentAction = "publish"|"withdraw"|"book"|"reschedule"|"cancel"|"complete"|"join";

export async function updateClientAppointment(db:Db, viewer:CallViewer, caseId:string, action:AppointmentAction, data:Record<string,unknown>) {
  return db.transaction(async tx=>{
    const row=await caseFor(tx,viewer,caseId,true);
    if (action==="publish") return newSlot(tx,viewer,row,data);
    if (action==="withdraw") return unpublishSlot(tx,viewer,row,data.slot);
    const staffId=viewer.side==="staff" ? viewer.id : null;
    const previous=action==="book" ? null : await appointmentById(tx,row,str(data.appointment,"appointment",80));
    if (action==="join" && previous) {
      const stamp=now();
      if (!bookableCase(row) || !matchesAssignment(previous,row) || (staffId && staffId!==previous.employee_id)) return fail(403,"This appointment is no longer assigned to you and your designated participant.");
      if (!joinWindow(previous,stamp)) return fail(409,"The meeting opens 10 minutes before the scheduled start and closes at the appointment end.");
      const existing=await one<{status:string}>(tx,`SELECT status FROM client_calls WHERE org_id=? AND customer_id=? AND employee_id=? AND case_id=?
        AND mode=? AND status IN ('Ringing','Accepted','Connected') AND created_at>=?
        AND (status<>'Ringing' OR ring_expires_at>?) AND (hard_expires_at IS NULL OR hard_expires_at>?) LIMIT 1`,
        row.org_id,row.customer_id,previous.employee_id,row.id,previous.mode,plus(previous.starts_at,-joinLead),stamp,stamp);
      let status=existing?.status;
      if (!status) {
        const reply=await startClientCall(tx,viewer,{case:row.id,mode:previous.mode,...(viewer.side==="client"?{target:"representative"}:{})});
        status=(await reply.json() as {call?:{status:string}}).call?.status;
      }
      if (!status || status==="Unavailable") return fail(503,"The meeting provider is unavailable. Try again or contact your representative.");
      if (!["Ringing","Accepted","Connected"].includes(status)) return fail(409,"A participant is on another call. Try again when they are free.");
      await event(tx,previous,"Join opened",staffId);
      return json({href:viewer.side==="client"?`/customer/contact?case=${encodeURIComponent(row.id)}`:`/staff/client-casework?tab=communication&case=${encodeURIComponent(row.id)}`});
    }

    await lockParticipants(tx,row,previous?.employee_id);
    const current=previous ? await appointmentById(tx,row,previous.id,true) : null;
    const stamp=now();
    if (current && (current.status!=="Booked" || current.revision!==integer(data.revision,"appointment version",1,2147483647))) {
      return fail(409,"The appointment changed. Refresh before trying again.");
    }
    if (current && action!=="complete" && current.starts_at<=stamp) return fail(409,"Appointment changes close at the scheduled start.");
    let result:Appointment|null=null;
    let change:EventName, title:string;
    if (action==="complete") {
      if (!staffId || !current) return fail(403,"Only the company can mark an appointment completed.");
      if (stamp<current.ends_at) return fail(409,"Mark the appointment completed after the scheduled end.");
      result=await one<Appointment>(tx,`UPDATE client_appointments SET status='Completed',revision=revision+1,updated_at=? WHERE id=? RETURNING ${appointmentFields}`,stamp,current.id);
      change="Completed";title="Appointment completed";
    } else if (action==="cancel" && current) {
      await clearSlot(tx,current);
      result=await one<Appointment>(tx,`UPDATE client_appointments SET status='Cancelled',revision=revision+1,updated_at=? WHERE id=? RETURNING ${appointmentFields}`,stamp,current.id);
      change="Cancelled";title="Appointment cancelled";
    } else if (action==="book" || action==="reschedule" && current) {
      const slot=await reserveSlot(tx,row,data,current ?? undefined);
      if (current) {
        await clearSlot(tx,current);
        result=await one<Appointment>(tx,`UPDATE client_appointments SET slot_id=?,employee_id=?,representative_name=?,starts_at=?,ends_at=?,
          time_zone=?,mode=?,revision=revision+1,updated_at=? WHERE id=? RETURNING ${appointmentFields}`,
          slot.id,slot.employee_id,row.representative_name,slot.starts_at,slot.ends_at,slot.time_zone,slot.mode,stamp,current.id);
      } else {
        result=await one<Appointment>(tx,`INSERT INTO client_appointments
          (id,org_id,case_id,customer_id,employee_id,slot_id,representative_name,starts_at,ends_at,time_zone,mode,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING ${appointmentFields}`,
          id(),row.org_id,row.id,row.customer_id,slot.employee_id,slot.id,row.representative_name,slot.starts_at,slot.ends_at,slot.time_zone,slot.mode,stamp,stamp);
      }
      change=current?"Rescheduled":"Booked";title=current?"Appointment rescheduled":"Appointment confirmed";
    } else return fail(400,"Choose a valid appointment action.");
    if (!result) return fail(409,"The appointment changed before this operation could finish.");
    await event(tx,result,change,staffId);
    await recordCaseEvent(tx,row,title,staffId ? {employeeId:staffId} : {customerId:viewer.id});
    await appointmentNotice(tx,result,change,title);
    await notifyCaseStaff(tx,{...row,assigned_employee_id:result.employee_id},title,"Review the scheduled consultation in casework.",`appointment:${result.id}:${result.revision}`);
    return json({appointment:appointmentDto(row,result,viewer,stamp)},action==="book"?201:200);
  });
}

export async function appointmentCalendar(db:Db,viewer:CallViewer,caseId:string,appointmentId:string) {
  const row=await caseFor(db,viewer,caseId), item=await appointmentById(db,row,appointmentId);
  if (item.status==="Cancelled") return fail(409,"This appointment was cancelled.");
  return privateCalendarFile({identity:"client-appointment:"+item.id,sequence:item.revision-1,startsAt:item.starts_at,
    endsAt:item.ends_at,title:"Walshken consultation",description:"Sign in to the secure Walshken portal to view or join.",
    filename:"walshken-consultation.ics"});
}

export async function maintainClientAppointmentReminders(db:Db, org:string) {
  const stamp=now();
  const due=await all<Appointment>(db,`SELECT ${appointmentFields.split(",").map(key=>`a.${key}`).join(",")} FROM client_appointments a
    JOIN client_cases c ON c.id=a.case_id AND c.org_id=a.org_id AND c.assigned_employee_id=a.employee_id AND c.communication_enabled
    JOIN employees e ON e.id=a.employee_id AND e.org_id=a.org_id AND e.status='Active' AND e.employment_status<>'Ended'
    JOIN customers customer ON customer.id=a.customer_id AND customer.email_verified_at IS NOT NULL AND customer.suspended_at IS NULL
    WHERE a.org_id=? AND a.status='Booked' AND a.starts_at>? AND a.starts_at<=?
      AND NOT EXISTS(SELECT 1 FROM client_appointment_events history WHERE history.appointment_id=a.id
        AND history.reference=a.revision::text AND history.event=CASE WHEN a.starts_at<=? THEN 'Reminder 1h' ELSE 'Reminder 24h' END)
    ORDER BY a.starts_at,a.id LIMIT 30`,org,stamp,plus(stamp,24*60*minute),plus(stamp,60*minute));
  let sent=0;
  for (const item of due) {
    sent+=await db.transaction(async tx=>{
      const live=await one<Appointment>(tx,`SELECT ${appointmentFields} FROM client_appointments
        WHERE id=? AND org_id=? AND revision=? AND status='Booked' AND starts_at>? FOR UPDATE SKIP LOCKED`,item.id,org,item.revision,stamp);
      if (!live) return 0;
      const reminder=live.starts_at<=plus(stamp,60*minute)?"Reminder 1h":"Reminder 24h";
      if (!(await event(tx,live,reminder,null,String(live.revision))).count) return 0;
      await appointmentNotice(tx,live,reminder,"Upcoming Walshken appointment");
      return 1;
    });
  }
  return {notificationsQueued:sent};
}
