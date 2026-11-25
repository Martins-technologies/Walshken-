import assert from 'node:assert/strict';

export async function verifyEmployment({db,request,admin,staff,hr,person,adminId,staffId,runId}) {
 process.env.WALSHKEN_EMPLOYMENT_ENGINE_ENABLED='1';
 const {one}=await import('../lib/walshken/server.ts');
 const {employmentTermsOn,applicablePolicy,policyDates,assertEmploymentPeriod}=await import('../lib/walshken/employment-engine.ts');
 const {workforcePolicy}=await import('../lib/walshken/workforce.ts');
 const {canadianAlbertaTax,canada2026}=await import('../lib/walshken/payroll-tax-ca.ts');
 const {zeroBalance}=await import('../lib/walshken/payroll-money.ts');
 const {defaultPayPolicy}=await import('../lib/walshken/payroll-access.ts');
 const {localDate}=await import('../lib/walshken/work.ts');
 const {dayAdd,defaultPolicy,localInstant}=await import('../lib/walshken/attendance-rules.ts');
 const reviewer=await person('admin','Independent policy verifier','POLICY-REV-'+runId);
 await db.prepare("UPDATE employees SET role='super_admin' WHERE id=?",[reviewer.id]).run();
 const call=(action,body,status=200,user=admin)=>request('governance/'+action,status,user,body);
 let data=(await request('view/governance',200,admin)).employment;
 const countryCount=await db.prepare('SELECT country,count(*)::int AS count FROM employment_regions GROUP BY country ORDER BY country',[]).all();
 assert.deepEqual(countryCount.results.map(row=>[row.country,row.count]),[['CA',14],['IN',37],['PK',8]]);
 assert.ok(data.regions.some(row=>row.code==='IN-GJ'));
 await call('employment-country-save',{country:'US'},400);
 await call('employment-region-save',{country:'PK',code:'IN-NEW',name:'Invalid',kind:'Province',enabled:true},400);
 const indian=await person('employee','Gujarat policy test employee','POLICY-IN-'+runId);
 const today=localDate(new Date().toISOString(),'America/Edmonton'),tomorrow=dayAdd(today,1),holiday=dayAdd(today,3);
 const assignment={employee:indian.id,country:'IN',region:'IN-GJ',jurisdiction:'IN-GJ',classification:'Synthetic office test category',city:'QA city',office:'',timeZone:'Asia/Kolkata',employmentType:'Full-time',employeeCategory:'QA fixture',compensationType:'Hourly',currency:'INR',frequency:'Monthly',expectedHours:40,schedule:'QA weekdays',effectiveOn:today,reference:'Isolated synthetic policy applicability, not legal compliance evidence'};
 await call('employment-terms-save',assignment,403,staff);
 await call('employment-terms-save',{...assignment,country:'PK'},400);
 await call('employment-terms-save',assignment,201);
 await call('employment-terms-save',assignment,409);
 const actor=await one(db,'SELECT * FROM employees WHERE id=?',indian.id);
 assert.equal((await employmentTermsOn(db,actor,today)).jurisdiction,'IN-GJ');
 assert.equal((await employmentTermsOn(db,actor,dayAdd(today,-1))),null);
 await assert.rejects(()=>workforcePolicy(db,actor,today),/PENDING LEGAL VERIFICATION/);
 const work={maxShiftMinutes:660,minRestMinutes:600,changeNoticeMinutes:1440,restHoursPerWeek:24,firstBreakAfterMinutes:240,secondBreakFromMinutes:480,minimumBreakMinutes:30,minimumSplitMinutes:15};
 async function draft(category,settings,extra={}) {
  const body={jurisdiction:'IN-GJ',classification:assignment.classification,category,version:category+'-QA-'+runId,effectiveFrom:today,effectiveThrough:dayAdd(today,60),source:'https://labour.gov.in/',evidence:'Synthetic test values demonstrate routing only, not legal verification',mandatory:true,settings,...extra};
  const created=await call('employment-policy-save',body,201);
  data=(await request('view/governance',200,admin)).employment;
  return data.policies.find(row=>row.version===body.version);
 }
 const w=await draft('Work',work);
 assert.equal((await applicablePolicy(db,actor,today,'Work',false)),null);
 await call('jurisdiction-verify',{id:w.id,reason:'Self review rejected'},403);
 await call('jurisdiction-verify',{id:w.id,reason:'HR cannot approve policy'},403,hr);
 await call('jurisdiction-verify',{id:w.id,reason:'Isolated synthetic fixture independently reviewed'},200,reviewer);
 assert.equal((await workforcePolicy(db,actor,today)).policy.rules.firstBreakAfterMinutes,240);
 await call('jurisdiction-withdraw',{id:w.id,reason:'An entitlement cannot be disabled'},409);
 const future=await draft('Work',{...work,firstBreakAfterMinutes:210},{version:'Future-work-'+runId,effectiveFrom:tomorrow,predecessor:w.id});
 await call('jurisdiction-verify',{id:future.id,reason:'Independent scheduled fixture review'},200,reviewer);
 assert.equal((await workforcePolicy(db,actor,today)).policy.rules.firstBreakAfterMinutes,240);
 assert.equal((await workforcePolicy(db,actor,tomorrow)).policy.rules.firstBreakAfterMinutes,210);
 const overlap=await draft('Work',work,{version:'Conflicting-work-'+runId,effectiveFrom:tomorrow});
 await call('jurisdiction-verify',{id:overlap.id,reason:'Ambiguous version conflict'},409,reviewer);
 await assert.rejects(()=>assertEmploymentPeriod(db,actor,today,tomorrow),/changes inside/);
 const calendar=await draft('Holiday calendar',{dates:[{date:holiday,name:'Synthetic regional test holiday',required:true}]});
 await call('jurisdiction-verify',{id:calendar.id,reason:'Independent synthetic date fixture review'},200,reviewer);
 const dates=await policyDates(db,actor,today,dayAdd(today,7));
 assert.equal(dates.dates.filter(row=>row.day===holiday).length,1);
 assert.equal((await policyDates(db,actor,today,dayAdd(today,63))).pending,true,'Expired mandatory calendar coverage is surfaced');
 const result=await request('view/calendar?'+new URLSearchParams({mode:'admin',from:today,to:dayAdd(today,7),types:'statutory',country:'IN',employee:indian.id}),200,admin);
 assert.equal(result.calendar.entries.filter(row=>row.title==='Synthetic regional test holiday').length,1);
 const overtime=await draft('Overtime',{dailyHours:9,weeklyHours:48,multiplier:'2',weekStart:1});
 await call('jurisdiction-verify',{id:overtime.id,reason:'Independent synthetic overtime fixture review'},200,reviewer);
 assert.equal((await applicablePolicy(db,actor,today,'Overtime')).settings.multiplier,'2');
 const settings=(await call('employment-coverage',{employee:indian.id,day:today})).coverage;
 assert.equal(settings.find(row=>row.category==='Leave').status,'Pending legal verification');
 await assert.rejects(()=>db.prepare("UPDATE staff_employment_terms SET country='CA' WHERE employee_id=?",[indian.id]).run(),/immutable/i);
 await assert.rejects(()=>db.prepare("UPDATE staff_jurisdiction_versions SET settings='{}' WHERE id=?",[w.id]).run(),/immutable/i);
 const leave=await draft('Leave',{workdays:[1,2,3,4,5],dayMinutes:480,yearStartMonth:1,proration:'None',categories:[{code:'ANNUAL',name:'Vacation',paid:true,annualMinutes:4800,carryMinutes:960,accrual:'Annual',minimumServiceDays:0}]});
 await call('jurisdiction-verify',{id:leave.id,reason:'Independent synthetic leave configuration test'},200,reviewer);
 const {employeeLeaveBalances}=await import('../lib/walshken/leave-balances.ts');
 const before=await employeeLeaveBalances(db,actor,today);
 assert.equal(before.balances[0].available,4800);
 const adjustment={employee:indian.id,effectiveOn:today,code:'ANNUAL',kind:'Carry forward',minutes:480,reason:'Fictional verified imported carry balance'};
 await call('employment-leave-adjust',{...adjustment,minutes:1000},400);
 await call('employment-leave-adjust',adjustment,201);
 const pending=(await request('view/governance',200,admin)).employment.leaveAdjustments[0];
 await call('employment-leave-adjust-review',{id:pending.id,decision:'Approved',reason:'Cannot approve own adjustment'},403);
 await call('employment-leave-adjust-review',{id:pending.id,decision:'Approved',reason:'Independent verified synthetic import'},200,reviewer);
 assert.equal((await employeeLeaveBalances(db,actor,today)).balances[0].available,5280);
 let leaveDay=dayAdd(today,1);while([0,6].includes(new Date(leaveDay+'T12:00Z').getUTCDay())||leaveDay===holiday)leaveDay=dayAdd(leaveDay,1);
 const scheduling=await import('../app/api/workforce/[action]/route.ts');
 async function time(action,body,status=200,user=indian){
  const request=new Request('https://test.walshken.test/api/workforce/'+action,{method:'POST',headers:{origin:'https://test.walshken.test',cookie:user.cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const res=await scheduling.POST(request,{params:Promise.resolve({action})});const value=await res.json();assert.equal(res.status,status,value.error);return value;
 }
 const requested=await time('leave-request',{category:'ANNUAL',startsOn:leaveDay,endsOn:leaveDay,note:'Synthetic leave request'},201);
 assert.equal((await employeeLeaveBalances(db,actor,today)).balances[0].pending,480);
 const leaveRow=await one(db,'SELECT * FROM leave_requests WHERE id=?',requested.id);
 await time('leave-review',{id:requested.id,revision:leaveRow.revision,decision:'Approved',note:'Actual independent manager review'},200,admin);
 assert.equal((await employeeLeaveBalances(db,actor,today)).balances[0].used,480);
 const after=await one(db,'SELECT * FROM leave_requests WHERE id=?',requested.id);
 await time('leave-cancel',{id:requested.id,revision:after.revision,note:'Test cancellation releases the reserved balance'});
 assert.equal((await employeeLeaveBalances(db,actor,today)).balances[0].available,5280);
 const {checkShift}=await import('../lib/walshken/scheduling.ts');
 const {workforcePolicyAt}=await import('../lib/walshken/workforce.ts');
 const at=stamp=>localInstant(stamp,'Asia/Kolkata');
 await assert.rejects(()=>checkShift(db,actor,actor,at(today+'T22:00'),at(tomorrow+'T04:00')),/Split this shift/);
 assert.equal((await workforcePolicyAt(db,actor,at(tomorrow+'T02:00'))).policy.rules.recordId,future.id);
 const clockTime=new Date(),clockStop=new Date(clockTime.getTime()+3600000).toISOString();
 const stale='stale-shift-'+runId;
 await db.prepare(`INSERT INTO shifts(id,org_id,employee_id,starts_at,ends_at,title,location,created_by,time_zone,release_stage,workflow_version,state,policy_snapshot)
   VALUES(?,?,?,?,?,'Synthetic policy snapshot check','QA worksite',?,'Asia/Kolkata','preview',1,'Published',?)`,
   [stale,actor.org_id,actor.id,clockTime.toISOString(),clockStop,adminId,JSON.stringify(defaultPolicy())]).run();
 const active=await time('clock-in',{shift:stale},201);
 const recorded=await one(db,'SELECT policy_snapshot,time_zone FROM attendance WHERE id=?',active.id);
 assert.equal(recorded.time_zone,'Asia/Kolkata');
 assert.equal(JSON.parse(recorded.policy_snapshot).rules.recordId,localDate(clockTime.toISOString(),'Asia/Kolkata')===today?w.id:future.id);

 const move=dayAdd(today,10),newHoliday=dayAdd(move,2);
 await call('employment-terms-save',{...assignment,country:'PK',region:'PK-PB',jurisdiction:'PK-PB',currency:'PKR',timeZone:'Asia/Karachi',effectiveOn:move},201);
 const nextCalendar=await draft('Holiday calendar',{dates:[{date:newHoliday,name:'Synthetic Punjab holiday',required:true}]},
   {jurisdiction:'PK-PB',version:'Punjab calendar '+runId,effectiveFrom:move,source:'https://punjablaws.gov.pk/'});
 await call('jurisdiction-verify',{id:nextCalendar.id,reason:'Independent synthetic Punjab calendar verification'},200,reviewer);
 const closure='dated-company-event-'+runId,closureDay=dayAdd(holiday,2);
 await db.prepare(`INSERT INTO holiday_company_events(id,org_id,release_stage,name,on_date,jurisdiction,kind,calendar_key,closed,guaranteed_minutes,targets,target_reference,created_by,created_at,updated_at,reference)
   VALUES(?,?,'preview','Synthetic Gujarat closure',?,'IN-GJ','Closure','',1,0,?,'Synthetic scoped targets',?,?,?,'Synthetic closure evidence')`,
   [closure,actor.org_id,closureDay,JSON.stringify([actor.id]),adminId,clockTime.toISOString(),clockTime.toISOString()]).run();
 const {employeeCompanyHolidays}=await import('../lib/walshken/holiday-access.ts');
 assert.equal((await employeeCompanyHolidays(db,actor,today,newHoliday))[0].id,closure);
 await assert.rejects(()=>checkShift(db,actor,actor,at(closureDay+'T08:00'),at(closureDay+'T13:00')),/company closure/);
 const calendarFor=(country,anchor)=>request('view/calendar?'+new URLSearchParams({mode:'admin',from:today,to:newHoliday,anchor,types:'statutory,company',country,employee:actor.id}),200,admin);
 const gujarat=(await calendarFor('IN',newHoliday)).calendar;
 assert(gujarat.entries.some(entry=>entry.title==='Synthetic regional test holiday'));
 assert(gujarat.entries.some(entry=>entry.title==='Synthetic Gujarat closure'));
 assert(!gujarat.entries.some(entry=>entry.title==='Synthetic Punjab holiday'));
 const punjab=(await calendarFor('PK',today)).calendar;
 assert(punjab.entries.some(entry=>entry.title==='Synthetic Punjab holiday'));
 assert(!punjab.entries.some(entry=>entry.title==='Synthetic Gujarat closure'));
 const indiaProfile={...defaultPayPolicy({country:'IN',jurisdiction:'IN-GJ'}),frequency:'Monthly',reviewed:true,
  reference:'Synthetic verified payroll profile',ruleSource:'https://labour.gov.in/',dailyHours:9,weeklyHours:48,overtimeMultiplier:'2'};
 const pakistanProfile={...defaultPayPolicy({country:'PK',jurisdiction:'PK-PB'}),frequency:'Monthly',reviewed:true,
  reference:'Synthetic verified successor profile',ruleSource:'https://punjablaws.gov.pk/',dailyHours:9,weeklyHours:48,overtimeMultiplier:'2'};
 const proposal={employee:actor.id,effectiveOn:today,currentId:'',note:'Dated employment association test'};
 const saved=await request('payroll/profile-save',201,admin,{...proposal,policy:indiaProfile});
 await request('payroll/profile-save',409,admin,{...proposal,effectiveOn:move,currentId:saved.id,policy:indiaProfile});
 await request('payroll/profile-save',201,admin,{...proposal,effectiveOn:move,currentId:saved.id,policy:pakistanProfile});
 const rate={employee:actor.id,amount:'2400',unit:'Hour',effectiveOn:move,note:'Synthetic reviewed payroll rate'};
 await request('payroll/rate-add',409,admin,{...rate,currency:'INR'});
 await request('payroll/rate-add',201,admin,{...rate,currency:'PKR'});
 console.log('PASS payroll setup follows dated assignments and refuses obsolete jurisdiction and rate currency');
 console.log('PASS assignment-dated calendar filters and closure checks, fresh clock-in rules, and overnight policy boundary');
 const report=await request('view/attendance?team=1',200,admin);
 assert.equal(report.managedWorkforce,true);
 await call('permission-save',{principalType:'role',principal:'manager',scopeType:'country',scopeId:'IN',capability:'people.read',effect:'allow'});
 await call('permission-save',{principalType:'role',principal:'manager',scopeType:'office',scopeId:'missing-office',capability:'people.read',effect:'allow'},404);
 console.log('PASS verified leave accrual, independent carry adjustments, pending reservations, approval, cancellation and country permissions');
 await db.prepare('DELETE FROM rate_limits',[]).run();
 const retention={country:'IN',category:'Documents',classification:'Private',minimumDays:30,retainDays:30,effectiveOn:today,source:'https://labour.gov.in/',reason:'Synthetic retention policy fixture'};
 await call('retention-save',{...retention,retainDays:1},400);
 await call('retention-save',retention,201);
 const retentionRow=(await request('view/governance',200,admin)).retention.versions[0];
 await call('retention-review',{id:retentionRow.id,decision:'Approved',reason:'Cannot self approve'},403);
 await call('retention-review',{id:retentionRow.id,decision:'Approved',reason:'Independent synthetic retention test'},200,reviewer);
 const {assertRecordRetention,assertNoLegalHold}=await import('../lib/walshken/retention.ts');
 await assert.rejects(()=>assertRecordRetention(db,actor.org_id,'IN','Documents',new Date().toISOString()),/not elapsed/);
 await assertRecordRetention(db,actor.org_id,'IN','Documents',new Date(Date.now()-45*86400000).toISOString());
 await call('hold-create',{scope:'organization',reason:'Synthetic legal preservation test'},201);
 const hold=(await request('view/governance',200,admin)).retention.holds[0];
 await assert.rejects(()=>assertNoLegalHold(db,actor.org_id,'document','any-record'),/legal hold/);
 await call('hold-release',{id:hold.id,reason:'Creator cannot release'},403);
 await call('hold-release',{id:hold.id,reason:'Independent release authority test'},200,reviewer);
 await assertNoLegalHold(db,actor.org_id,'document','any-record');
 const {quarantinedUpload}=await import('../lib/walshken/upload-quarantine.ts');
 const {encryptSettings}=await import('../lib/walshken/server.ts');
 const {randomBytes}=await import('node:crypto');
 const storageId='qa-quarantine-storage';
 const storage={endpoint:'https://ssggjxyexwkshtcypsaq.storage.supabase.co/storage/v1/s3',region:'us-west-2',bucket:'qa-private-quarantine',accessKey:'synthetic-test',secretKey:randomBytes(32).toString('base64url')};
 await db.prepare('INSERT INTO integrations(id,configuration,enabled,updated_at) VALUES(?,?,1,?)',[storageId,await encryptSettings(storageId,storage),new Date().toISOString()]).run();
 const oldStorage=process.env.WALSHKEN_DOCUMENT_STORAGE_ID,realFetch=globalThis.fetch;
 process.env.WALSHKEN_DOCUMENT_STORAGE_ID=storageId;
 const objects=new Map();
 globalThis.fetch=async(input,options)=>{
  const request=input instanceof Request?input:new Request(input,options),url=new URL(request.url);
  assert.equal(url.hostname,'ssggjxyexwkshtcypsaq.storage.supabase.co');
  if(request.method==='PUT'){objects.set(url.pathname,Buffer.from(await request.arrayBuffer()));return new Response(null,{status:200});}
  if(request.method==='DELETE'){objects.delete(url.pathname);return new Response(null,{status:204});}
  throw Error('Unexpected quarantine test storage operation');
 };
 try{
  const clean=await quarantinedUpload(db,actor,Buffer.from('clean test data'),'clean-test.txt',async()=> 'clean');
  assert.equal((await one(db,'SELECT status FROM staff_upload_scans WHERE id=?',clean)).status,'Clean');
  assert.equal(objects.size,0);
  await assert.rejects(()=>quarantinedUpload(db,actor,Buffer.from('synthetic infected verdict'),'infected-test.txt',async()=> 'infected'),/remains quarantined/);
  const infected=await one(db,"SELECT * FROM staff_upload_scans WHERE file_name='infected-test.txt'");
  assert.equal(infected.status,'Quarantined');assert.equal(objects.size,1);
  await assert.rejects(()=>quarantinedUpload(db,actor,Buffer.from('timeout test'),'failed-test.txt',async()=>{throw Error('Synthetic transport failure');}),/not been released/);
  assert.equal((await one(db,"SELECT status FROM staff_upload_scans WHERE file_name='failed-test.txt'")).status,'Failed');
  assert.equal(objects.size,2);
  await assert.rejects(()=>db.prepare("UPDATE staff_upload_scan_events SET status='Clean' WHERE scan_id=?",[infected.id]).run(),/immutable/i);
 }finally{globalThis.fetch=realFetch;if(oldStorage===undefined)delete process.env.WALSHKEN_DOCUMENT_STORAGE_ID;else process.env.WALSHKEN_DOCUMENT_STORAGE_ID=oldStorage;}
 console.log('PASS retention minimums, independent review, legal hold enforcement, release separation and fail-closed quarantine workflow with a simulated scanner transport');
 const profile=defaultPayPolicy({country:'CA',jurisdiction:'CA-AB'}).taxProfile;
 const taxInput={payDate:'2027-05-01',currency:'CAD',periods:12,periodIndex:5,taxable:300000,pensionable:300000,insurable:300000,bonus:0,bonusPensionable:0,bonusInsurable:0,pretax:0,bonusPretax:0,lastRegular:0,ytd:zeroBalance(),profile};
 assert.throws(()=>canadianAlbertaTax(taxInput),/verified tax-year/);
 // Synthetic future-year parameters test mechanics, not published rates.
 const synthetic={...canada2026,year:2027,validFrom:'2027-01-01',validThrough:'2027-12-31',version:'SYNTHETIC-2027-QA'};
 assert.equal(canadianAlbertaTax(taxInput,synthetic).taxYear,2027);
 assert.equal(canadianAlbertaTax(taxInput,synthetic).version,'SYNTHETIC-2027-QA');
 console.log('PASS complete three-country geographic registry, effective employment assignments, pending-rule gates, independent approval, immutable policies, conflict rejection, future rule routing, country calendar and versioned tax-year parameters');
 process.env.WALSHKEN_EMPLOYMENT_ENGINE_ENABLED='0';
}
