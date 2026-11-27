import assert from "node:assert/strict";
import { POST as guestRoute } from "../app/api/meeting-guest/[action]/route.ts";
import { processMeetingInvitationEmails } from "../lib/walshken/meeting-invitation-email.ts";
import { meetingGuestLink, processInternalMeetingReminders, scheduledMeetingTime } from "../lib/walshken/meeting-invitations.ts";

export async function verifyExternalMeetingInvitations({db,request,admin,staff,staffId,adminId,values,participants,emit,settings,TokenVerifier,encryptSettings,origin}) {
  process.env.WALSHKEN_MANAGEMENT_INVITES_ENABLED="1";
  process.env.WALSHKEN_STAFF_EMAIL_ORIGIN=origin;
  const read=(sql,...params)=>db.prepare(sql,params).first();
  const all=(sql,...params)=>db.prepare(sql,params).all().then(x=>x.results);
  const run=(sql,...params)=>db.prepare(sql,params).run();
  const requestGuest=async (action,expected,guest,payload={},browser={})=>{
    const req=new Request(origin+"/api/meeting-guest/"+action,{
      method:"POST",headers:{origin,"content-type":"application/json",...(browser.cookie?{cookie:browser.cookie}:{})},
      body:JSON.stringify({guest,...payload}),
    });
    const res=await guestRoute(req,{params:Promise.resolve({action})}),body=await res.json();
    assert.equal(res.status,expected,action+" "+JSON.stringify(body));
    if(res.headers.has("set-cookie")){
      browser.cookie=res.headers.get("set-cookie").split(";")[0];
      assert.match(res.headers.get("set-cookie"),/HttpOnly; Secure; SameSite=Strict; Path=\/api\/meeting-guest/);
    }
    return body;
  };
  const calendar=(guest,browser={})=>guestRoute(new Request(origin+"/api/meeting-guest/calendar",{
    method:"POST",headers:{origin,"content-type":"application/json",...(browser.cookie?{cookie:browser.cookie}:{})},
    body:JSON.stringify({guest}),
  }),{params:Promise.resolve({action:"calendar"})});
  const future=ms=>new Date(Date.now()+ms).toISOString();
  const options={...values,title:"External video meeting",type:"Group",mode:"Video",waiting:"0",members:[staffId],
    description:"Project meeting",instructions:"Bring the agenda",timeZone:"Asia/Karachi",
    startsAt:future(60_000),endsAt:future(3_600_000),externalEmails:"Guest@partner.test, QA-Declined@partner.test;guest@partner.test"};
  assert.equal(scheduledMeetingTime("2027-02-05T15:30","meeting start","Asia/Karachi"),"2027-02-05T10:30:00.000Z");
  assert.throws(()=>scheduledMeetingTime("2027-03-14T02:30","start","America/Toronto"),/clock change/);
  assert.throws(()=>scheduledMeetingTime("2027-11-07T01:30","start","America/Toronto"),/unambiguous/);
  await request("calls/schedule",403,admin,options);
  assert.equal(await read("SELECT id FROM meetings WHERE title=?",options.title),null,"Unauthorized invites must not leave a partial meeting");
  await request("calls/guest-policy",403,staff,{enabled:"1",admission:"Host approval"});
  await request("calls/guest-policy",200,admin,{enabled:"1",admission:"Host approval"});
  await request("calls/schedule",403,staff,{...options,members:[adminId]});
  const {id}=await request("calls/schedule",201,admin,options);
  await processInternalMeetingReminders(db,"walshken");
  await processInternalMeetingReminders(db,"walshken");
  assert.equal((await read("SELECT count(*)::int AS n FROM notifications WHERE employee_id=? AND href=? AND title='Meeting starts soon'",staffId,"/staff/calls?meeting="+id)).n,1);
  const rows=await all("SELECT * FROM staff_meeting_guests WHERE meeting_id=? ORDER BY email",id);
  assert.equal(rows.length,2,"Canonical and duplicate email handling");
  const [external,declined]=rows;
  const vercelEnvironment = {VERCEL_ENV:process.env.VERCEL_ENV,VERCEL_BRANCH_URL:process.env.VERCEL_BRANCH_URL,VERCEL_URL:process.env.VERCEL_URL};
  try {
    process.env.VERCEL_ENV="preview";
    process.env.VERCEL_BRANCH_URL="stable-preview.vercel.app";
    process.env.VERCEL_URL="deployment-preview.vercel.app";
    assert.equal(new URL(meetingGuestLink(external)).host,"stable-preview.vercel.app");
    assert.equal(new URL(meetingGuestLink(external,"https://deployment-preview.vercel.app")).host,"deployment-preview.vercel.app");
    assert.equal(new URL(meetingGuestLink(external,"https://other.vercel.app")).host,"stable-preview.vercel.app");
    delete process.env.VERCEL_BRANCH_URL;
    assert.equal(new URL(meetingGuestLink(external)).host,"deployment-preview.vercel.app");
    delete process.env.VERCEL_URL;
    assert.throws(()=>meetingGuestLink(external),/staff email origin/);
  } finally {
    for (const [key,value] of Object.entries(vercelEnvironment)) {
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
    }
  }
  const organizerDetails=await request("meeting/"+id,200,admin);
  const participantDetails=await request("meeting/"+id,200,staff);
  assert.equal(organizerDetails.externalGuests.find(g=>g.id===external.id).email,"guest@partner.test");
  assert.equal(participantDetails.externalGuests.find(g=>g.id===external.id).email,null);
  assert.equal(participantDetails.externalGuests.find(g=>g.id===external.id).opened,null);
  assert.equal(participantDetails.externalGuests.some(g=>g.url||g.session_hash||g.token_nonce),false);
  await request("calls/guest-link",401,{cookie:""},{id,guest:external.id});
  await request("calls/guest-link",403,staff,{id,guest:external.id});
  assert.equal((await request("calls/guest-link",200,admin,{id,guest:external.id})).url,meetingGuestLink(external));
  assert.equal((await calendar(external.id)).status,401);
  assert.equal((await request("view/calls",200,admin)).guestInvites.emailConfigured,false);
  assert.equal((await request("view/integrations",200,admin)).meetingInviteEmail,true);
  await request("calls/guest-delivery",503,admin,{id});
  await request("calls/guest-delivery",403,staff,{id});
  assert.equal((await processMeetingInvitationEmails(db)).provider,"disconnected");
  assert.equal(await read("SELECT id FROM employees WHERE email=?",external.email),null,"Email guests must not become employee accounts");
  await run("INSERT INTO integrations(id,configuration,enabled) VALUES('resend',?,1)",await encryptSettings("resend",{apiKey:"re_test_mocked_sender_1234",from:"staff@notify.walshken.test"}));
  const actualFetch=globalThis.fetch,attempted=[],delivered=[];
  let first=true;
  globalThis.fetch=async (url,opts)=>{
    if (new URL(url).origin!=="https://api.resend.com") return actualFetch(url,opts);
    const payload=JSON.parse(opts.body);
    assert.match(opts.headers["Idempotency-Key"],/^walshken-meeting\/walshken\//);
    attempted.push({key:opts.headers["Idempotency-Key"],payload});
    if(first){first=false;return Response.json({message:"retry"},{status:429});}
    delivered.push(payload);
    return Response.json({id:"test_provider_"+delivered.length});
  };
  try{
    await request("calls/guest-delivery",200,admin,{id});
    assert.equal(attempted.length,2);
    assert.equal((await read("SELECT count(*)::int AS n FROM staff_meeting_guest_emails WHERE meeting_id=? AND status='Retry'",id)).n,1);
    await run("UPDATE staff_meeting_guest_emails SET available_at=? WHERE meeting_id=? AND status='Retry'",future(-10),id);
    await request("calls/guest-delivery",200,admin,{id});
    assert.equal(delivered.length,2);
    assert.equal(attempted[0].key,attempted[2].key);
    assert.deepEqual(attempted[0].payload,attempted[2].payload,"Retries must send identical signed message content");
    for(const mail of delivered){
      assert.match(mail.subject,/Meeting invitation.*External video meeting/);
      assert.match(mail.text,/Part B QA Admin.*Asia\/Karachi.*Bring the agenda/s);
      assert.match(mail.html,/Open meeting invitation/);
    }
    const invitation=delivered.find(mail=>mail.to[0]===external.email);
    const href=invitation.text.match(/https:\/\/[^\s]+\/meeting-access#[^\s]+/)[0];
    assert.equal(new URL(href).origin,origin);
    const [guest,token]=new URL(href).hash.slice(1).split(".");
    assert.equal(guest,external.id);
    assert.equal(Object.values(external).includes(token),false,"Only a nonce is stored with the invitation");
    await requestGuest("exchange",404,guest,{token:"A".repeat(43)});
    const browser={};
    assert.equal((await requestGuest("exchange",200,guest,{token},browser)).status,"Invited");
    await request("calls/guest-link",409,admin,{id,guest});
    const event=await calendar(guest,browser);
    assert.equal(event.status,200);
    assert.match(event.headers.get("content-type"),/^text\/calendar/);
    assert.match(event.headers.get("content-disposition"),/walshken-meeting\.ics/);
    assert.match(event.headers.get("cache-control"),/no-store/);
    const eventText=await event.text();
    assert.ok(eventText.split("\r\n").every(line=>Buffer.byteLength(line)<=75),"Fold calendar data at 75 UTF-8 octets");
    assert.match(eventText,/BEGIN:VCALENDAR\r\n.*DTSTART:\d{8}T\d{6}Z\r\n.*SUMMARY:External video meeting/s);
    assert.doesNotMatch(eventText,new RegExp(`${token}|${guest}|guest@partner|roomAdmin|livekit`));
    await requestGuest("exchange",409,guest,{token},{});
    await requestGuest("join",403,guest,{},browser);
    await request("view/profile",401,{cookie:browser.cookie});
    await request("meeting/"+id,401,{cookie:browser.cookie});
    await requestGuest("status",401,declined.id,{},browser);
    await requestGuest("accept",200,guest,{name:"External tester"},browser);
    await requestGuest("accept",200,guest,{name:"External tester"},browser);
    assert.equal((await read("SELECT count(*)::int AS n FROM notifications WHERE employee_id=? AND title='External meeting invitation accepted'",adminId)).n,1);
    const declineBrowser={};
    const declineToken=new URL(meetingGuestLink(declined)).hash.split(".")[1];
    await requestGuest("exchange",200,declined.id,{token:declineToken},declineBrowser);
    await requestGuest("decline",200,declined.id,{},declineBrowser);
    await requestGuest("join",403,declined.id,{},declineBrowser);
    assert.equal((await calendar(declined.id,declineBrowser)).status,403);
    await requestGuest("join",202,guest,{},browser);
    await request("calls/guest-admit",403,staff,{id,guest});
    await request("calls/guest-admit",200,admin,{id,guest});
    const access=await requestGuest("join",200,guest,{},browser);
    const claims=await new TokenVerifier(settings.apiKey,settings.apiSecret).verify(access.token);
    assert.equal(claims.video.room,"wk-"+id);
    assert.deepEqual(claims.video.canPublishSources,["microphone","camera"]);
    assert.ok(!claims.video.roomAdmin&&!claims.video.roomRecord&&!claims.video.canPublishData);
    assert.ok(claims.exp-claims.nbf<=60);
    await emit("room_finished",claims.video.room);
    assert.equal((await requestGuest("status",200,guest,{},browser)).status,"Accepted","An empty provider room must not end a scheduled meeting.");
    await requestGuest("join",200,guest,{},browser);
    const remote={identity:claims.sub,sid:"PA_external_guest",kind:"STANDARD",joinedAt:String(Math.floor(Date.now()/1000))};
    participants.set(claims.video.room,[remote]);
    await emit("participant_joined",claims.video.room,remote);
    const connected=await request("meeting/"+id,200,admin);
    assert.equal(connected.externalGuests.find(g=>g.id===guest).connected,true);
    assert.equal(connected.attendance.find(g=>g.id===guest).connections,1);
    await request("calls/guest-permissions",200,admin,{id,guest,publish:"0",share:"0"});
    const limited=await requestGuest("join",200,guest,{},browser);
    assert.equal((await new TokenVerifier(settings.apiKey,settings.apiSecret).verify(limited.token)).video.canPublish,false);
    await request("calls/guest-revoke",403,staff,{id,guest});
    await request("calls/guest-revoke",200,admin,{id,guest});
    assert.equal(participants.get(claims.video.room).length,0);
    await requestGuest("join",404,guest,{},browser);
    assert.equal((await calendar(guest,browser)).status,404);
    await requestGuest("exchange",404,guest,{token},{});
    await request("calls/guest-invite",200,admin,{id,externalEmails:[declined.email]});
    const reinvited=await read("SELECT * FROM staff_meeting_guests WHERE id=?",declined.id);
    assert.equal(reinvited.rsvp,"Invited");
    assert.notEqual(reinvited.token_nonce,declined.token_nonce);
    await requestGuest("exchange",404,declined.id,{token:declineToken},declineBrowser);

    const scheduled=(await request("calls/schedule",201,admin,{...options,title:"Future external meeting",members:[],externalEmails:["future@partner.test"],startsAt:future(7_200_000),endsAt:future(10_800_000)})).id;
    const scheduledGuest=await read("SELECT * FROM staff_meeting_guests WHERE meeting_id=?",scheduled);
    const initialToken=new URL(meetingGuestLink(scheduledGuest)).hash.split(".")[1];
    const initialBrowser={};
    await requestGuest("exchange",200,scheduledGuest.id,{token:initialToken},initialBrowser);
    await requestGuest("accept",200,scheduledGuest.id,{name:"External tester"},initialBrowser);
    const originalCalendar=(await (await calendar(scheduledGuest.id,initialBrowser)).text()).replace(/\r\n /g,"");
    await request("calls/reschedule",404,staff,{id:scheduled,startsAt:future(3_600_000),endsAt:future(7_200_000)});
    await request("calls/reschedule",200,admin,{id:scheduled,startsAt:future(3_600_000),endsAt:future(7_200_000),timeZone:"America/Toronto"});
    await requestGuest("status",401,scheduledGuest.id,{},initialBrowser);
    await requestGuest("exchange",404,scheduledGuest.id,{token:initialToken},initialBrowser);
    await request("calls/guest-delivery",200,admin,{id:scheduled});
    const rescheduled=delivered.filter(mail=>mail.subject.startsWith("Meeting rescheduled"));
    assert.equal(rescheduled.length,1);
    const newToken=new URL(rescheduled[0].text.match(/https:\/\/[^\s]+\/meeting-access#[^\s]+/)[0]).hash.split(".")[1];
    assert.notEqual(newToken,initialToken);
    assert.equal((await requestGuest("exchange",200,scheduledGuest.id,{token:newToken},initialBrowser)).status,"Accepted");
    const changedCalendar=(await (await calendar(scheduledGuest.id,initialBrowser)).text()).replace(/\r\n /g,"");
    assert.equal(originalCalendar.match(/^UID:.+$/m)[0],changedCalendar.match(/^UID:.+$/m)[0]);
    assert.notEqual(originalCalendar.match(/^DTSTART:.+$/m)[0],changedCalendar.match(/^DTSTART:.+$/m)[0]);
    const sequence=value=>Number(value.match(/^SEQUENCE:(\d+)\r?$/m)[1]);
    assert.equal(sequence(changedCalendar),sequence(originalCalendar)+1);
    await run("UPDATE staff_meeting_guest_emails SET available_at=? WHERE guest_id=? AND status='Queued' AND event_type='Reminder'",future(-10),scheduledGuest.id);
    await processMeetingInvitationEmails(db);
    await processMeetingInvitationEmails(db);
    assert.equal(delivered.filter(mail=>mail.subject.startsWith("Meeting reminder")).length,1);
    await request("calls/cancel",200,admin,{id:scheduled});
    await request("calls/guest-delivery",200,admin,{id:scheduled});
    const cancelled=delivered.filter(mail=>mail.subject.startsWith("Meeting cancelled"));
    assert.equal(cancelled.length,1);
    assert.doesNotMatch(cancelled[0].text,/meeting-access#/);
    await run("UPDATE staff_meeting_guests SET expires_at=? WHERE id=?",future(-1000),scheduledGuest.id);
    await requestGuest("exchange",404,scheduledGuest.id,{token:newToken},{});
    await request("calls/guest-policy",200,admin,{enabled:"0",admission:"Host approval"});
  } finally {
    globalThis.fetch=actualFetch;
    delete process.env.WALSHKEN_MANAGEMENT_INVITES_ENABLED;
    delete process.env.WALSHKEN_STAFF_EMAIL_ORIGIN;
  }
  console.log("PASS external invitation sharing, private calendar files, provider-contract retries, RSVP, host admission, restricted guest tokens, revocation, expiry, rescheduling and reminders");
}
