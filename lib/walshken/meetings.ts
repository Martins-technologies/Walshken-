import { teamOptions } from "./collaboration";
import { all, audit, canSuper, colleague, datetime, decryptSettings, fail, id, json, notify, now, one, pick, requireStaff, requireSuper, run, stmt, str, throttle, type Actor, type Db, type Row } from "./server";

type Meeting = {
  id: string; organizer_id: string; title: string; starts_at: string; ends_at: string; cancelled_at: string | null;
  provider_room: string | null; mode: "Audio" | "Video"; waiting_room: number; screen_sharing: string;
  requested_at: string | null; admitted_at: string | null;
};
type DailySettings = { apiKey: string; domain: string };

async function guestPolicy(db: Db, actor: Actor) {
  const policy = await one<{ external_meetings: number }>(db,"SELECT external_meetings FROM organizations WHERE id=?",actor.org_id);
  return policy?.external_meetings === 1;
}
async function dailySettings(db: Db) {
  const integration = await one<{ configuration: string }>(db,"SELECT configuration FROM integrations WHERE id='daily' AND enabled=1");
  if(!integration) return fail(409,"A Super Admin must enable Daily calling in Integrations.");
  const settings = await decryptSettings("daily",integration.configuration);
  if(!settings.apiKey || !/^[a-z0-9][a-z0-9-]{1,60}$/i.test(settings.domain)) return fail(409,"Check the Daily credentials in Integrations.");
  return { apiKey: settings.apiKey, domain: settings.domain.toLowerCase() };
}
async function daily(path:string, settings:DailySettings, method:"GET"|"POST"|"DELETE", body?:Record<string,unknown>) {
  try {
    return await fetch(`https://api.daily.co/v1/${path}`, {
      method, headers:{Authorization:`Bearer ${settings.apiKey}`,"Content-Type":"application/json"},
      body:body?JSON.stringify(body):undefined, cache:"no-store",redirect:"error",signal:AbortSignal.timeout(8000),
    });
  } catch {
    return fail(502,"Daily is temporarily unreachable.");
  }
}
export async function verifyDailyConnection(settings:DailySettings) {
  const response=await daily("rooms?limit=1",settings,"GET");
  if(!response.ok) return fail(400,"Daily did not accept this API key. Check the key and retry.");
  const result=await response.json();
  if(!Array.isArray(result.data)) return fail(502,"Daily returned an unexpected response.");
  const origin=`https://${settings.domain.toLowerCase()}.daily.co/`;
  if(result.data.some((room:{url?:string})=>!room.url?.startsWith(origin))) return fail(400,"The Daily subdomain does not match this account.");
}
const linkTo=(meeting:string)=>`/staff/calls?meeting=${encodeURIComponent(meeting)}`;

export async function meetings(db: Db,actor: Actor) {
  if(actor.role==="guest"&&!await guestPolicy(db,actor)) return [];
  return all<Row>(db,`SELECT m.id,m.title,m.starts_at,m.ends_at,m.mode,m.waiting_room,m.organizer_id,m.cancelled_at,e.name AS organizer,
    p.requested_at,p.admitted_at FROM meetings m JOIN meeting_members p ON p.meeting_id=m.id JOIN employees e ON e.id=m.organizer_id
    WHERE m.org_id=? AND p.employee_id=? ORDER BY m.starts_at DESC LIMIT 100`,actor.org_id,actor.id);
}
export async function meetingViews(db: Db,actor: Actor) {
  const allowGuests=await guestPolicy(db,actor);
  const staff=await teamOptions(db,actor);
  if(canSuper(actor)&&allowGuests) staff.push(...await all<Row>(db,`SELECT id,name || ' (guest)' AS name FROM employees
    WHERE org_id=? AND status='Active' AND employment_status<>'Ended' AND role='guest' ORDER BY name`,actor.org_id));
  const pending=actor.role==="guest"?[]:await all(db,`SELECT p.id,m.id AS meeting,m.title,e.name,e.id AS employee,p.requested_at
    FROM meeting_members p JOIN meetings m ON m.id=p.meeting_id JOIN employees e ON e.id=p.employee_id
    WHERE m.org_id=? AND m.organizer_id=? AND m.cancelled_at IS NULL AND m.ends_at>? AND p.requested_at IS NOT NULL
    AND p.admitted_at IS NULL AND e.status='Active' AND e.employment_status<>'Ended' AND (?=1 OR e.role<>'guest')
    ORDER BY p.requested_at`,actor.org_id,actor.id,now(),allowGuests?1:0);
  return json({rows:await meetings(db,actor),staff,pendingAttendees:pending,guestMeetings:allowGuests,
    provider:Boolean(await one(db,"SELECT id FROM integrations WHERE id='daily' AND enabled=1"))});
}
export async function meetingAction(db: Db,actor: Actor,action: string,data: Record<string,unknown>) {
  await throttle(db,`calls:${actor.id}`,30,60_000);
  if(action==="guest-policy") {
    requireSuper(actor);
    const enabled=pick(data.enabled,["0","1"],"guest access")==="1"?1:0;
    await db.batch([stmt(db,"UPDATE organizations SET external_meetings=? WHERE id=?",enabled,actor.org_id),audit(db,actor,"Meeting guest policy updated","organization",actor.org_id)]);
    return json({ok:true,message:"Meeting guest policy saved."});
  }
  if(action==="schedule"||action==="start"){
    requireStaff(actor);
    if(!Array.isArray(data.members)||data.members.length>99) return fail(400,"Choose up to 99 invited participants.");
    const participants=[...new Set(data.members.map(item=>str(item,"participant",80)))].filter(employee=>employee!==actor.id);
    if(!participants.length) return fail(400,"Choose at least one participant.");
    const type=pick(data.type??"Group",["One-to-one","Group"],"call size");
    if(type==="One-to-one"&&participants.length!==1) return fail(400,"Choose exactly one participant for a one-to-one call.");
    const allowGuests=canSuper(actor)&&await guestPolicy(db,actor);
    await Promise.all(participants.map(async employee=>{
      if(allowGuests&&await one(db,`SELECT id FROM employees WHERE id=? AND org_id=? AND role='guest' AND status='Active' AND employment_status<>'Ended'`,employee,actor.org_id)) return;
      const person=await colleague(db,actor,employee);
      if(person.employment_status==="Ended") return fail(404,"Participant is unavailable.");
    }));
    if(action==="start") await dailySettings(db);
    const start=action==="start"?now():datetime(data.startsAt,"meeting start");
    const end=action==="start"?new Date(Date.parse(start)+60*60_000).toISOString():datetime(data.endsAt,"meeting end");
    if(end<=start||end<=now()||Date.parse(end)-Date.parse(start)>12*60*60_000) return fail(400,"Choose a future end time within 12 hours of the start.");
    const mode=pick(data.mode??"Video",["Audio","Video"],"call mode");
    const waitingRoom=pick(data.waiting??"0",["0","1"],"waiting room")==="1"?1:0;
    const screenSharing=pick(data.screenSharing??"Everyone",["Everyone","Host","Disabled"],"screen sharing");
    const target=id(),title=str(data.title,"meeting title",100);
    await db.batch([
      stmt(db,`INSERT INTO meetings (id,org_id,organizer_id,title,starts_at,ends_at,mode,waiting_room,screen_sharing) VALUES (?,?,?,?,?,?,?,?,?)`,
        target,actor.org_id,actor.id,title,start,end,mode,waitingRoom,screenSharing),
      ...[actor.id,...participants].map(employee=>stmt(db,"INSERT INTO meeting_members (id,meeting_id,employee_id) VALUES (?,?,?)",id(),target,employee)),
      ...participants.map(employee=>notify(db,employee,action==="start"?"Call invitation":"Meeting scheduled",title,linkTo(target))),
      audit(db,actor,action==="start"?"Instant call created":"Meeting scheduled","meeting",target),
    ]);
    return json({ok:true,id:target,message:action==="start"?"Call created. Join it from the meeting list.":"Meeting scheduled."},201);
  }

  const target=str(data.id,"meeting",80);
  if(actor.role==="guest"&&!await guestPolicy(db,actor)) return fail(404,"Meeting is unavailable.");
  if(!["join","admit","cancel"].includes(action)) return fail(404,"Meeting action unavailable.");
  return db.transaction(async tx=>{
    const meeting=await one<Meeting>(tx,`SELECT m.*,p.requested_at,p.admitted_at FROM meetings m
      JOIN meeting_members p ON p.meeting_id=m.id WHERE m.id=? AND m.org_id=? AND p.employee_id=? FOR UPDATE OF m`,target,actor.org_id,actor.id);
    if(!meeting||meeting.cancelled_at) return fail(404,"Meeting is unavailable.");
    const host=meeting.organizer_id===actor.id;
    if(action==="cancel") {
      if(!host) return fail(403,"Only the host can cancel this meeting.");
      if(meeting.ends_at<=now()) return fail(409,"This meeting has already ended.");
      if(meeting.provider_room) {
        const settings=await dailySettings(tx);
        const response=await daily(`rooms/${encodeURIComponent(meeting.provider_room)}`,settings,"DELETE");
        if(!response.ok && response.status!==404) return fail(502,"Daily could not close the current room.");
      }
      await run(tx,"UPDATE meetings SET cancelled_at=? WHERE id=?",now(),target);
      await run(tx,`INSERT INTO notifications (id,employee_id,title,body,href)
        SELECT ? || p.id,p.employee_id,'Meeting cancelled',?,'/staff/calls' FROM meeting_members p
        WHERE p.meeting_id=? AND p.employee_id<>?`,id(),meeting.title,target,actor.id);
      await audit(tx,actor,"Meeting cancelled","meeting",target).run();
      return json({ok:true,message:"Meeting cancelled."});
    }
    if(Date.now()<Date.parse(meeting.starts_at)-15*60_000||Date.now()>Date.parse(meeting.ends_at)) return fail(409,"You can join from 15 minutes before the meeting starts until it ends.");
    if(action==="admit"){
      if(!host||!meeting.waiting_room) return fail(403,"Only the host can admit waiting participants.");
      const person=str(data.employee,"participant",80);
      const allowGuests=await guestPolicy(tx,actor);
      const changed=await run(tx,`UPDATE meeting_members p SET admitted_at=? FROM employees e
        WHERE p.meeting_id=? AND p.employee_id=e.id AND e.id=? AND e.org_id=? AND e.status='Active' AND e.employment_status<>'Ended'
        AND (?=1 OR e.role<>'guest') AND p.admitted_at IS NULL AND p.requested_at IS NOT NULL`,now(),target,person,actor.org_id,allowGuests?1:0);
      if(changed.count!==1) return fail(404,"The participant is no longer waiting.");
      await notify(tx,person,"Meeting access approved","The host admitted you to the meeting.",linkTo(target)).run();
      await audit(tx,actor,"Meeting participant admitted","meeting",`${target}/${person}`).run();
      return json({ok:true,message:"Participant admitted."});
    }

    const settings=await dailySettings(tx);
    if(!host&&meeting.waiting_room&&!meeting.admitted_at) {
      if(!meeting.requested_at) {
        await run(tx,"UPDATE meeting_members SET requested_at=? WHERE meeting_id=? AND employee_id=?",now(),target,actor.id);
        await notify(tx,meeting.organizer_id,"Participant in the waiting room","Open Calls & meetings to admit invited participants.",linkTo(target)).run();
      }
      return json({ok:true,waiting:true,message:"Waiting for the host to admit you."},202);
    }
    const room=`wk-${target}`;
    if(!/^[a-z0-9-]{1,64}$/.test(room)) return fail(409,"Meeting reference is invalid.");
    const exp=Math.floor(Date.parse(meeting.ends_at)/1000);
    const lookup=await daily(`rooms/${room}`,settings,"GET");
    const remote=lookup.status===404?await daily("rooms",settings,"POST",{name:room,privacy:"private",properties:{
      exp,eject_at_room_exp:true,enable_knocking:false,enable_screenshare:meeting.screen_sharing!=="Disabled",start_video_off:meeting.mode==="Audio",
      enable_prejoin_ui:true,
    }}):lookup;
    const expected=`https://${settings.domain}.daily.co/${room}`;
    const providerRoom=remote.ok?await remote.json():null;
    if(providerRoom?.url!==expected||providerRoom.privacy!=="private") return fail(502,"Daily could not verify a private room for this account.");
    await run(tx,"UPDATE meetings SET provider_room=? WHERE id=?",room,target);
    const token=await daily("meeting-tokens",settings,"POST",{properties:{
      room_name:room,user_name:actor.name,user_id:actor.id,exp,eject_at_token_exp:true,is_owner:host,start_video_off:meeting.mode==="Audio",
      enable_screenshare:meeting.screen_sharing==="Everyone"||(host&&meeting.screen_sharing==="Host"),enable_recording_ui:false,
      ...(meeting.mode==="Audio"?{permissions:{canSend:meeting.screen_sharing==="Everyone"||(host&&meeting.screen_sharing==="Host")?["audio","screenVideo","screenAudio"]:["audio"]}}:{}),
    }});
    const access=token.ok?await token.json():null;
    if(typeof access?.token!=="string"||!access.token) return fail(502,"Daily could not grant meeting access.");
    await audit(tx,actor,"Meeting join authorized","meeting",target).run();
    return json({ok:true,url:`${expected}?t=${encodeURIComponent(access.token)}`});
  });
}
