import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const latestProfile = (db, employee) => db.prepare(
  "SELECT * FROM payroll_profiles WHERE employee_id=? AND release_stage='preview' ORDER BY effective_on DESC,created_at DESC,id DESC LIMIT 1", [employee]
).first();
const savedStatement = (db, period) => db.prepare(
  'SELECT id,status,calculation,calculation_hash,gross_cents,net_minor FROM payroll WHERE period_id=?', [period]
).first();

async function rolledBackFixture(db,work){
  const rollback=new Error('Rollback disposable regression fixture');
  try{await db.transaction(async tx=>{await work(tx);throw rollback;});}catch(error){if(error!==rollback)throw error;}
}

async function verifyPakistanPrecision({db,admin,hr,employee,period}){
  const {payrollAction}=await import('../lib/walshken/payroll-actions.ts'),{currentActor}=await import('../lib/walshken/server.ts');
  const actor=await currentActor(db,new Request('https://test.walshken.test',{headers:{cookie:admin.cookie}}));
  const opening=await db.prepare("SELECT * FROM payroll_openings WHERE employee_id=? AND status='Approved' ORDER BY created_at DESC,id DESC LIMIT 1",[employee.id]).first();
  const recorded=JSON.parse(opening.balances);assert.equal(recorded.currencyPrecision,2,'New PKR openings explicitly record their calculation precision');
  for(const nonzero of [false,true])await rolledBackFixture(db,async tx=>{
    const legacy={...recorded};delete legacy.currencyPrecision;if(nonzero)legacy.gross=1000;
    await tx.prepare('INSERT INTO payroll_openings(id,org_id,release_stage,employee_id,tax_year,as_of,balances,created_by,created_at,reference,status,approved_by,reviewed_at,review_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[randomUUID(),'walshken','preview',employee.id,2027,'2026-06-30',JSON.stringify(legacy),actor.id,new Date(Date.now()+1000).toISOString(),'Synthetic legacy precision fixture','Approved',hr.id,new Date().toISOString(),'Independent historical fixture']).run();
    const calculate=()=>payrollAction(tx,actor,'calculate',{period:period.id,employee:employee.id});
    if(nonzero)await assert.rejects(calculate,error=>error.status===409&&/legacy PKR opening balances/.test(error.message),'Unmarked nonzero openings require explicit review instead of being silently rescaled');
    else assert.equal((await calculate()).status,200,'Unambiguous legacy zero openings remain usable');
  });
  await rolledBackFixture(db,async tx=>{
    await tx.prepare('INSERT INTO compensation(id,employee_id,kind,amount_cents,currency,effective_on,created_by,release_stage,minor_unit,rate_unit,note,workflow_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',[randomUUID(),employee.id,'Salaried',1200000,'PKR','2026-09-01',actor.id,'preview',0,'Year','Synthetic legacy whole-rupee rate']).run();
    await assert.rejects(()=>payrollAction(tx,actor,'calculate',{period:period.id,employee:employee.id}),error=>error.status===409&&/historical pay rate.*precision/.test(error.message),'A legacy whole-rupee rate cannot silently become a hundredth-rupee rate');
  });
  assert.equal((await db.prepare('SELECT balances FROM payroll_openings WHERE id=?',[opening.id]).first()).balances,opening.balances,'Precision checks leave the retained opening record unchanged');
}

async function verifyExistingHolidayObligations({db,admin,hr,employee,period}){
  const {payrollAction}=await import('../lib/walshken/payroll-actions.ts'),{currentActor}=await import('../lib/walshken/server.ts');
  const actor=await currentActor(db,new Request('https://test.walshken.test',{headers:{cookie:admin.cookie}}));
  for(const deferred of [true,false])await rolledBackFixture(db,async tx=>{
    const assessment=randomUUID(),stamp=new Date().toISOString();
    const configuration={facts:{method:deferred?'Future paid day':'Pay now',payDay:deferred?'2026-10-12':'2026-07-01',dayPayMinor:24000}};
    await tx.prepare('INSERT INTO holiday_assessments(id,org_id,release_stage,employee_id,holiday_date,configuration,source_hash,status,reference,created_by,created_at,reviewed_by,reviewed_at,review_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[assessment,'walshken','preview',employee.id,'2026-07-01',JSON.stringify(configuration),'synthetic-obligation-source','Approved','Synthetic pre-existing approved entitlement',actor.id,stamp,hr.id,stamp,'Independently reviewed historical fixture']).run();
    if(!deferred){
      const historical=randomUUID();
      await tx.prepare('INSERT INTO payroll(id,org_id,employee_id,starts_on,ends_on,currency,payable_seconds,gross_cents,status,calculation,created_by,created_at,release_stage,period_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[historical,'walshken',employee.id,'2026-07-01','2026-07-31','CAD',0,0,'Estimate','{}',actor.id,stamp,'preview',period.id]).run();
      await tx.prepare('INSERT INTO holiday_reconciliations(id,org_id,release_stage,employee_id,holiday_date,payroll_id,assessment_id,status,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[randomUUID(),'walshken','preview',employee.id,'2026-07-01',historical,assessment,'Pending',JSON.stringify({requiresAssessment:true,requiredDelta:24000,currency:'CAD'}),stamp]).run();
    }
    await assert.rejects(()=>payrollAction(tx,actor,'calculate',{period:period.id,employee:employee.id}),error=>error.status===409&&(deferred?/previously approved deferred holiday payment/:/holiday correction/).test(error.message),deferred?'Changing to a zero company holiday method cannot erase a due previously approved holiday payment':'Changing company financial settings cannot hide a pending holiday correction');
  });
}

export async function verifyAlbertaCompanyPolicies(context) {
  const {db,post,list,person,setupEmployee,approvedWork,period,policy,admin,hr,staff,managerUser,adminId,runId}=context;
  const employee=await person('employee','Company policy regression','COMPANY-AB-'+runId);
  await db.prepare("UPDATE employees SET hire_date='2020-01-01',contract_start='2020-01-01' WHERE id=?",[employee.id]).run();
  await setupEmployee(employee.id,'52000','Year',policy);
  const first=await latestProfile(db,employee.id);
  assert.equal(JSON.parse(first.settings).companyConfigured,true,'The authorized save must record that these are selected company values');

  // Simulate an untouched profile saved by the preceding release. This is a
  // disposable fixture, not a rewrite of any retained application record.
  const legacy={...policy};delete legacy.companyConfigured;delete legacy.policyValueSource;
  const legacyId=randomUUID();
  await db.prepare(`INSERT INTO payroll_profiles(id,org_id,release_stage,employee_id,effective_on,settings,created_by,created_at,note)
    VALUES(?,?,?,?,?,?,?,?,?)`,[legacyId,'walshken','preview',employee.id,'2026-01-02',JSON.stringify(legacy),adminId,new Date().toISOString(),'Synthetic existing unmodified policy']).run();
  const legacyPeriod=(await period('Existing policy remains unchanged','2026-08-24','2026-08-30',[employee.id])).id;
  await post('calculate',{period:legacyPeriod,employee:employee.id});
  let data=await list(admin,legacyPeriod);
  assert.equal(data.rows[0].calculation.vacationAccrued,6000,'An unmodified legacy long-service policy keeps its existing reference calculation');
  assert.equal(data.rows[0].gross_cents,106000);
  const finalize=async id=>{
    let result=await list(admin,id);
    await post('period-submit',{id,revision:result.selected.revision});
    result=await list(admin,id);
    await post('payroll-review',{id:result.rows[0].id,revision:result.rows[0].revision,decision:'Approved',note:'Independent synthetic company-policy review',acknowledge:true},200,hr);
    result=await list(admin,id);
    await post('period-finalize',{id,revision:result.selected.revision,note:'Approved isolated policy calculation'});
    return savedStatement(db,id);
  };
  const frozenLegacy=await finalize(legacyPeriod);
  const zeroPolicy={...policy,companyConfigured:true,policyValueSource:'Employee override',vacationPercent:'0',overtime:'Configured rule',dailyHours:0,weeklyHours:0,overtimeMultiplier:'0'};
  const zeroBody={employee:employee.id,effectiveOn:'2026-09-01',currentId:legacyId,note:'Explicit company rates, including zero',policy:zeroPolicy};
  await post('profile-save',zeroBody,403,staff);
  await post('profile-save',zeroBody,403,managerUser);
  await post('profile-save',{...zeroBody,policy:{...zeroPolicy,vacationPercent:'-1'}},400);
  await post('profile-save',zeroBody,201);
  const savedZero=await latestProfile(db,employee.id),zeroSettings=JSON.parse(savedZero.settings);
  assert.equal(zeroSettings.companyConfigured,true,'The selected company-value mode survives persistence');
  assert.equal(zeroSettings.vacationPercent,'0');
  assert.equal(zeroSettings.overtimeMultiplier,'0');
  assert.equal(zeroSettings.dailyHours,0);
  assert.equal(zeroSettings.weeklyHours,0);
  const zeroPeriod=(await period('Explicit zero vacation','2026-09-14','2026-09-20',[employee.id])).id;
  await post('calculate',{period:zeroPeriod,employee:employee.id});
  data=await list(admin,zeroPeriod);
  assert.equal(data.rows[0].calculation.vacationAccrued,0,'Zero must not fall back to the 4% or long-service 6% reference');
  assert.equal(data.rows[0].gross_cents,100000);
  assert.equal(data.rows[0].calculation.policy.vacationPercent,'0');
  const frozenZero=await finalize(zeroPeriod);

  await post('profile-save',{employee:employee.id,effectiveOn:'2026-10-01',currentId:savedZero.id,note:'Chosen future company vacation rate',policy:{...policy,policyValueSource:'Employee override',vacationPercent:'7.25'}},201);
  const higherPeriod=(await period('Explicit higher vacation','2026-10-19','2026-10-25',[employee.id])).id;
  await post('calculate',{period:higherPeriod,employee:employee.id});
  data=await list(admin,higherPeriod);
  assert.equal(data.rows[0].calculation.vacationAccrued,7250);
  assert.equal(data.rows[0].gross_cents,107250);
  assert.deepEqual(await savedStatement(db,legacyPeriod),frozenLegacy,'A later company policy must not rewrite a finalized legacy statement');
  assert.deepEqual(await savedStatement(db,zeroPeriod),frozenZero,'A later company rate must not rewrite the finalized zero-rate statement');
  const {payProfile}=await import('../lib/walshken/payroll-access.ts');
  const actualEmployee=await db.prepare('SELECT * FROM employees WHERE id=?',[employee.id]).first();
  const actor=await db.prepare('SELECT * FROM employees WHERE id=?',[adminId]).first();
  assert.equal((await payProfile(db,actor,actualEmployee,'2026-08-24')).id,legacyId);
  assert.equal((await payProfile(db,actor,actualEmployee,'2026-09-14')).policy.vacationPercent,'0');
  assert.equal((await payProfile(db,actor,actualEmployee,'2026-10-19')).policy.vacationPercent,'7.25');
  const hourly=await person('employee','Zero overtime rate regression','COMPANY-OT-'+runId);
  await setupEmployee(hourly.id,'30','Hour',{...policy,overtime:'Configured rule',dailyHours:8,weeklyHours:44,overtimeMultiplier:'0',vacationPercent:'0'});
  await approvedWork('2026-03-02','09:00','19:30',hourly.id);
  const overtimePeriod=(await period('Explicit zero overtime multiplier','2026-03-02','2026-03-08',[hourly.id])).id;
  await post('calculate',{period:overtimePeriod,employee:hourly.id});
  const overtimeRow=(await list(admin,overtimePeriod)).rows[0];
  assert.equal(overtimeRow.regular_seconds,8*3600);
  assert.equal(overtimeRow.overtime_seconds,2*3600);
  assert.equal(overtimeRow.calculation.lines.find(line=>line.kind==='Overtime').amount,0,'Selected zero overtime must not be replaced by a reference multiplier');
  assert.equal(overtimeRow.gross_cents,24000);
  console.log('PASS explicit Alberta zero/higher company rates, untouched legacy defaults, authorization, effective dates and immutable finalized snapshots');
}

export async function verifyCountryCompanyPolicies(context) {
  const {db,request,admin,hr,staff,person,runId}=context;
  const {verifyCountryWorkflows}=await import('./verify-enterprise.mjs');
  const financeAdmin=await person('admin','Scoped company policy administrator','FINANCE-ADMIN-'+runId);
  const employeeClerk=await person('admin','Employee-scoped payroll administrator','FINANCE-CLERK-'+runId);
  const prepareAdmin=await person('admin','Payroll preparation without policy authority','PREPARE-ADMIN-'+runId);
  const grant=(employee,scopeType,scopeId,capability='payroll.rules')=>request('governance/permission-save',200,admin,{principalType:'employee',principal:employee,scopeType,scopeId,capability,effect:'allow'});
  const profiles=new Map(),baseGross=new Map();
  let canadianPolicy;
  const companyRunId=runId+'-company';
  await verifyCountryWorkflows({...context,runId:companyRunId,payStandards:{vacationPercent:'4',longServiceVacationPercent:'6'},
    beforeCalculate:async({pa,employee,period,country,policy})=>{
      if(country==='PK')await verifyPakistanPrecision({db,admin,hr,employee,period});
      const current=await latestProfile(db,employee.id);
      await pa('profile-save',{employee:employee.id,effectiveOn:'2026-10-01',currentId:current.id,note:'Explicit zero selected for this employee',policy:{...policy,vacationMode:'Each pay',vacationPercent:'0',policyValueSource:'Employee override'}},201);
      profiles.set(country,await latestProfile(db,employee.id));
    },
    afterCalculate:async({pa,employee,period,country,jurisdiction,policy})=>{
      let data=await request('view/payroll?period='+period.id,200,admin);
      assert.equal(data.rows[0].calculation.vacationAccrued,0,country+' explicit zero overrides the synthetic 4% reference');
      baseGross.set(country,data.rows[0].gross_cents);
      const terms=await db.prepare('SELECT * FROM staff_employment_terms WHERE employee_id=? ORDER BY effective_on DESC LIMIT 1',[employee.id]).first();
      const original=await db.prepare("SELECT * FROM staff_jurisdiction_versions WHERE org_id='walshken' AND jurisdiction=? AND classification=? AND category='Pay standards' ORDER BY effective_from DESC LIMIT 1",[jurisdiction,terms.classification]).first();
      const selected={...JSON.parse(original.settings),vacationPercent:'0',longServiceVacationPercent:'0',minimumHourly:'0',minimumMonthly:'0',holidayPremiumMultiplier:'0',reportingHours:0,paymentDeadlineDays:0};
      const body={jurisdiction,classification:terms.classification,category:'Pay standards',version:'Company zero '+country+' '+companyRunId,effectiveFrom:'2026-10-01',effectiveThrough:'2027-12-31',source:original.source_url,evidence:'Selected company values in an isolated regression fixture',mandatory:true,predecessor:original.id,settings:selected};
      if(country==='CA')canadianPolicy=body;
      await request('governance/employment-policy-save',403,staff,body);
      await grant(employeeClerk.id,'employee',employee.id);
      await request('governance/employment-policy-save',403,employeeClerk,body);
      const department=(await db.prepare('SELECT department_id FROM employees WHERE id=?',[employee.id]).first()).department_id;
      await grant(employeeClerk.id,'department',department);
      await request('governance/employment-policy-save',403,employeeClerk,body);
      await grant(prepareAdmin.id,'country',country,'payroll.prepare');
      await request('governance/employment-policy-save',403,prepareAdmin,body);
      await request('governance/employment-policy-save',403,financeAdmin,body);
      await grant(financeAdmin.id,'country',country);
      await request('governance/employment-policy-save',403,financeAdmin,{...body,category:'Work'});
      await request('governance/employment-policy-save',400,financeAdmin,{...body,settings:{...selected,vacationPercent:'-1'}});
      await request('governance/employment-policy-save',201,financeAdmin,body);
      const company=await db.prepare('SELECT * FROM staff_jurisdiction_versions WHERE version=?',[body.version]).first();
      assert.equal(JSON.parse(company.settings).companyConfigured,true);
      assert.equal(JSON.parse(company.settings).vacationPercent,'0');
      await request('governance/jurisdiction-verify',403,financeAdmin,{id:company.id,reason:'Self review must remain rejected'});
      await request('governance/jurisdiction-verify',200,admin,{id:company.id,reason:'Independent review of selected company values'});
      let current=await latestProfile(db,employee.id);
      await pa('profile-save',{employee:employee.id,effectiveOn:'2026-10-01',currentId:current.id,note:'Use the selected jurisdiction policy',policy:{...policy,vacationMode:'Each pay',vacationPercent:'7.25',policyValueSource:'Jurisdiction policy'}},201);
      await pa('calculate',{period:period.id,employee:employee.id});
      data=await request('view/payroll?period='+period.id,200,admin);
      assert.equal(data.rows[0].calculation.vacationAccrued,0,country+' jurisdiction selection inherits the configured zero instead of the dormant employee percentage');
      current=await latestProfile(db,employee.id);
      await pa('profile-save',{employee:employee.id,effectiveOn:'2026-10-01',currentId:current.id,note:'Choose an explicit employee percentage',policy:{...policy,vacationMode:'Each pay',vacationPercent:'7.25',policyValueSource:'Employee override'}},201);
      await pa('calculate',{period:period.id,employee:employee.id});
      data=await request('view/payroll?period='+period.id,200,admin);
      // Monthly salary minus the one holiday salary offset, rounded per line.
      const expected={CA:34602,IN:346023,PK:692045}[country];
      assert.equal(data.rows[0].calculation.vacationAccrued,expected,country+' selected 7.25% must calculate exactly');
      assert.equal(data.rows[0].gross_cents,baseGross.get(country)+expected);
      assert.equal(data.rows[0].calculation.policy.vacationPercent,'7.25');
      profiles.set(country,await latestProfile(db,employee.id));
    },
    afterFinalize:async({pa,employee,period,country,policy})=>{
      const frozen=await savedStatement(db,period.id);
      assert.equal(frozen.status,'Finalized');
      const legacy={...policy,vacationMode:'Each pay',vacationPercent:'4'};
      delete legacy.companyConfigured;delete legacy.policyValueSource;
      const creator=(await db.prepare('SELECT id FROM employees WHERE email=?',[admin.email]).first()).id;
      await db.prepare(`INSERT INTO payroll_profiles(id,org_id,release_stage,employee_id,effective_on,settings,created_by,created_at,note)
        VALUES(?,?,?,?,?,?,?,?,?)`,[randomUUID(),'walshken','preview',employee.id,'2026-11-01',JSON.stringify(legacy),creator,new Date().toISOString(),'Synthetic unmodified profile with a future effective date']).run();
      const next=await pa('period-create',{label:'Company zero inheritance '+country,startsOn:'2026-11-01',endsOn:'2026-11-30',payDate:'2026-11-30',frequency:'Monthly',periodsPerYear:12,employees:[employee.id]},201);
      if(country!=='CA'){
        const input=await db.prepare('SELECT configuration FROM staff_statutory_inputs WHERE employee_id=? AND period_id=? ORDER BY created_at DESC,id DESC LIMIT 1',[employee.id,period.id]).first();
        const saved=await pa('statutory-input-add',{employee:employee.id,period:next.id,configuration:JSON.parse(input.configuration),reference:'Independently reviewed next-period synthetic declarations'},201);
        await pa('statutory-input-review',{id:saved.id,decision:'Approved',reason:'Independent next-period synthetic review'},200,hr);
      }
      await pa('calculate',{period:next.id,employee:employee.id});
      const nextRow=(await request('view/payroll?period='+next.id,200,admin)).rows[0];
      assert.equal(nextRow.calculation.vacationAccrued,0,country+' unmarked employee profile inherits the intentionally selected jurisdiction zero');
      assert.deepEqual(await savedStatement(db,period.id),frozen,country+' later policy dates and calculations preserve the finalized statement bytes and hash');
    }
  });
  // Alberta historically used its older holiday-calculation branch. Exercise
  // actual worked and non-worked holiday amounts through the company policy.
  await verifyCountryWorkflows({...context,runId:runId+'-ab0',countries:[['CA','CA-AB','CAD','60000']],holidayPayExpected:false,
    beforeCalculate:async({employee,period,jurisdiction})=>{
      const terms=await db.prepare('SELECT classification FROM staff_employment_terms WHERE employee_id=? ORDER BY effective_on DESC LIMIT 1',[employee.id]).first();
      const original=await db.prepare("SELECT * FROM staff_jurisdiction_versions WHERE org_id='walshken' AND jurisdiction=? AND classification=? AND category='Pay standards' ORDER BY effective_from DESC LIMIT 1",[jurisdiction,terms.classification]).first();
      const settings={...JSON.parse(original.settings),holidayMethod:'Percent of earnings',holidayPercent:'0',holidayPremiumMultiplier:'0',vacationPercent:'0',longServiceVacationPercent:'0'};
      await request('governance/employment-policy-save',201,financeAdmin,{jurisdiction,classification:terms.classification,category:'Pay standards',version:'Selected zero Alberta holiday amounts '+runId,effectiveFrom:'2026-10-01',effectiveThrough:'2027-12-31',source:'https://www.alberta.ca/alberta-general-holidays',evidence:'Isolated company holiday amount regression',mandatory:true,predecessor:original.id,settings});
      const selected=await db.prepare("SELECT * FROM staff_jurisdiction_versions WHERE org_id='walshken' AND jurisdiction=? AND classification=? AND category='Pay standards' ORDER BY effective_from DESC,created_at DESC,id DESC LIMIT 1",[jurisdiction,terms.classification]).first();
      await request('governance/jurisdiction-verify',200,admin,{id:selected.id,decision:'Verified',reason:'Independent review of the explicitly chosen holiday amounts'});
      const {workforceAction}=await import('../lib/walshken/workforce.ts'),{currentActor,handleError}=await import('../lib/walshken/server.ts'),{localInstant}=await import('../lib/walshken/attendance-rules.ts');
      const work=async(action,body,status=200,user=admin)=>{
        const actor=await currentActor(db,new Request('https://test.walshken.test',{headers:{cookie:user.cookie}}));let response;
        try{response=await workforceAction(db,actor,action,body);}catch(error){response=handleError(error);}
        const result=await response.json();assert.equal(response.status,status,action+' '+JSON.stringify(result));return result;
      };
      for(const day of ['2026-10-08','2026-10-12']){
        const attendance=await work('manual-entry',{employee:employee.id,startsAt:localInstant(day+'T09:00','America/Toronto'),endsAt:localInstant(day+'T17:30','America/Toronto'),timeZone:'America/Toronto',breaks:[{kind:'lunch',startsAt:localInstant(day+'T12:00','America/Toronto'),endsAt:localInstant(day+'T12:30','America/Toronto')}],note:'Actual historical and holiday work in isolated payroll regression'},201);
        const sheet=await db.prepare('SELECT id,revision FROM timesheets WHERE attendance_id=?',[attendance.id]).first();
        await work('timesheet-review',{id:sheet.id,revision:sheet.revision,decision:'Approved',note:'Independent verification of actual worked time',acknowledge:true},200,hr);
      }
      await verifyExistingHolidayObligations({db,admin,hr,employee,period});
    },
    afterCalculate:async({period})=>{
      const row=(await request('view/payroll?period='+period.id,200,admin)).rows[0],calculation=row.calculation;
      const worked=calculation.lines.find(line=>line.kind==='Holiday work');
      assert.equal(worked.seconds,8*3600,'Approved holiday work must reach the real pay calculation');
      assert.equal(worked.amount,0,'Selected zero premium must not be replaced by Alberta 1.5 times pay');
      const snapshot=calculation.countryEmployment.snapshots.find(day=>day.day==='2026-10-12');
      assert.equal(snapshot.eligible,true);assert(snapshot.basis>0,'The zero percentage must be tested against real positive historical earnings');
      assert.equal(snapshot.amount,0,'Selected zero holiday percentage must not be replaced by average daily wages');
      assert.equal(calculation.countryEmployment.standards.companyConfigured,true);
      assert.equal(row.gross_cents,500000,'Monthly base salary remains, with zero added holiday amounts');
    }
  });
  await grant(prepareAdmin.id,'organization','');
  await request('governance/permission-save',200,admin,{principalType:'employee',principal:prepareAdmin.id,scopeType:'country',scopeId:'CA',capability:'payroll.rules',effect:'deny'});
  await request('governance/employment-policy-save',403,prepareAdmin,canadianPolicy);
  console.log('PASS CA/IN/PK zero and higher rates, scoped Admin policy changes, jurisdiction-versus-employee priority, future inheritance and retained finalized payroll');
}
