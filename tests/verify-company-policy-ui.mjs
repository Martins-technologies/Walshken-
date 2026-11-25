// Optional DOM regression check. Uses only synthetic data and blocked/mock fetches.
// Requires Node 22, the project's npm-ci dependencies (React and esbuild), and jsdom 27.2.0.
// Reproduce without changing the project's dependencies:
//   npm install --prefix /tmp/walshken-ui-dom --no-save --package-lock=false jsdom@27.2.0
//   WALSHKEN_UI_JSDOM=/tmp/walshken-ui-dom/node_modules/jsdom/lib/api.js node tests/verify-company-policy-ui.mjs
// If jsdom is already installed in the test environment, no override is needed.
// This optional check is not registered in scripts/verify-tests.mjs or the production build gate.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const {JSDOM,VirtualConsole}=await import(process.env.WALSHKEN_UI_JSDOM||'jsdom');
const repo=fileURLToPath(new URL('..',import.meta.url));
const entry=`import React from 'react';
import {createRoot} from 'react-dom/client';
import {PayrollPolicyEditor} from './components/walshken/payroll-policy-editor';
import {PayrollWorkspace} from './components/walshken/payroll';
import {nationalTaxPackages} from './lib/walshken/payroll-national-packages';
const root=createRoot(document.getElementById('app'));let key=0;
window.nationalPackages=nationalTaxPackages();
window.renderPolicy=props=>root.render(<PayrollPolicyEditor key={++key} {...props} refresh={()=>{}}/>);
window.renderEmployee=policy=>{const data={manager:true,superAdmin:true,staffReadiness:true,holidayManagement:false,enterprise:false,employerValidation:false,periods:[],selected:null,staff:[{id:'fixture-person',name:'Synthetic Employee',employee_no:'FIXTURE',role:'employee',jurisdiction:policy.jurisdiction,employment_type:'Hourly',defaultPolicy:policy}],rates:[],profiles:[],openings:[],rows:[],items:[],members:[],settings:null,settingsRevision:0,payments:[],delegations:[],events:[],reconciliations:[],approvedTimesheets:[],approvedLeaves:[],totals:[],holidays:[],needsSetup:false};root.render(<PayrollWorkspace key={++key} actor={{id:'fixture-admin',role:'super_admin',name:'Synthetic Admin'}} data={data} refresh={()=>{}} setQuery={()=>{}}/>);};
window.fetch=async(url,init)=>{if(!['/api/workspace/governance/employment-policy-save','/api/payroll/profile-save'].includes(String(url)))throw new Error('Fixture blocks external or unexpected requests: '+url);window.saved={url,body:JSON.parse(init.body)};return new Response(JSON.stringify({ok:true,message:'Synthetic save'}),{headers:{'Content-Type':'application/json'}});};`;
const bundle=await build({stdin:{contents:entry,resolveDir:repo,loader:'tsx'},bundle:true,write:false,outfile:path.join(repo,'policy-ui-fixture.js'),platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'tsconfig.json')});
const errors=[],logger=new VirtualConsole();
logger.on('jsdomError',error=>errors.push(String(error)));
logger.on('error',error=>errors.push(String(error)));
const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://fixture.invalid',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:logger});
const w=dom.window;w.structuredClone=structuredClone;w.Response=Response;
w.eval(bundle.outputFiles.find(file=>file.path.endsWith('.js')).text);
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
const label=text=>[...w.document.querySelectorAll('label')].find(row=>row.textContent.trim().startsWith(text));
const change=(element,value)=>{assert.ok(element);const prototype=element instanceof w.HTMLSelectElement?w.HTMLSelectElement.prototype:element instanceof w.HTMLTextAreaElement?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new w.Event(element instanceof w.HTMLSelectElement?'change':'input',{bubbles:true}));};
const click=text=>{const button=[...w.document.querySelectorAll('button')].find(item=>item.textContent===text);assert.ok(button,text);button.click();};
const fillMetadata=()=>{for(const [name,value] of Object.entries({version:'Synthetic company version',effectiveFrom:'2026-12-01',effectiveThrough:'2026-12-31',evidence:'Synthetic DOM check only'}))w.document.querySelector(`[name="${name}"]`).value=value;};
const submit=async()=>{const form=w.document.querySelector('.company-policy-form');assert.equal(form.checkValidity(),true,[...form.elements].filter(field=>field.validity&&!field.validity.valid).map(field=>field.name||field.closest('label')?.textContent).join('\n'));form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();return JSON.parse(w.saved.body.settings);};

// National references apply to actual state/province jurisdictions, in either selection order.
for(const country of ['IN','PK']){
 const pkg=w.nationalPackages.find(item=>item.country===country),category=country==='IN'?'India payroll':'Pakistan payroll';
 const reference={id:pkg.version,country,jurisdiction:'',category,classification:'Synthetic employee',version:pkg.version,source:pkg.source,effectiveFrom:pkg.validFrom,effectiveThrough:pkg.validThrough,settings:pkg};
 const jurisdictions=country==='IN'?[['IN-DL','Delhi'],['IN-GJ','Gujarat']]:[['PK-PB','Punjab'],['PK-SD','Sindh']];
 for(const jurisdictionFirst of [true,false]){
  w.renderPolicy({category,country,suggestions:[reference],jurisdictions});await tick();
  if(jurisdictionFirst){change(label('Employment jurisdiction').querySelector('select'),jurisdictions[0][0]);await tick();}
  const picker=label('Government reference suggestion').querySelector('select');
  assert.ok([...picker.options].some(option=>option.value===reference.id));
  change(picker,reference.id);await tick();click('Use reference values as starting values');await tick();
  if(jurisdictionFirst)assert.equal(label('Employment jurisdiction').querySelector('select').value,jurisdictions[0][0]);
  else{change(label('Employment jurisdiction').querySelector('select'),jurisdictions[0][0]);await tick();}
  assert.equal(label('Government reference suggestion').querySelector('select').value,reference.id);
  assert.equal(w.document.querySelector('[name="source"]').value,reference.source);
  change(label('Employment jurisdiction').querySelector('select'),jurisdictions[1][0]);await tick();
  assert.equal(label('Government reference suggestion').querySelector('select').value,reference.id);
  assert.equal(w.document.querySelector('[name="source"]').value,reference.source);
  const contributionGroup=[...w.document.querySelectorAll('fieldset')].find(group=>group.querySelector('legend')?.textContent.includes(pkg.contributions[0].label));
  if(country==='IN')assert.equal([...contributionGroup.querySelectorAll('label')].some(row=>row.textContent.startsWith('Employer contribution rate')),false);
  const rate=[...contributionGroup.querySelectorAll('label')].find(row=>row.textContent.startsWith(country==='IN'?'Total employer contribution rate':'Employee contribution rate')).querySelector('input');
  change(rate,'0');await tick();fillMetadata();const settings=await submit();
  assert.equal(w.saved.body.jurisdiction,jurisdictions[1][0]);
  assert.equal(settings.contributions[0][country==='IN'?'employerTotalRate':'employeeRate'],'0');
  assert.equal(settings.companyConfigured,true);
  assert.notEqual(reference.settings.contributions[0][country==='IN'?'employerTotalRate':'employeeRate'],'0');
 }
}

// Optional holiday eligibility controls remain distinct from wage averaging and preserve zero.
const suggested={currency:'CAD',minimumHourly:'15',minimumMonthly:'0',vacationPercent:'4',longServiceYears:5,longServiceVacationPercent:'6',paymentDeadlineDays:10,holidayPremiumMultiplier:'1.5',holidayMethod:'Average worked day',holidayWindowDays:28,holidayWindowBasis:'Before holiday',holidayDivisor:0,holidayPayOnNonWorkday:false,holidayPercent:'0',minimumServiceDays:0,minimumWorkedDays:30,eligibilityLookbackMonths:12,regularDayLookbackWeeks:9,regularDayMinimumOccurrences:5,reportingHours:3,reportingRate:'Minimum wage'};
const reference={id:'ca-reference',country:'CA',jurisdiction:'CA-AB',category:'Pay standards',classification:'Synthetic employee',version:'Synthetic reference',source:'https://www.alberta.ca/vacation-pay',effectiveFrom:'2026-01-01',effectiveThrough:'2026-12-31',settings:suggested};
const selected={...suggested,vacationPercent:'0',companyConfigured:true};
w.renderPolicy({category:'Pay standards',country:'CA',suggestions:[reference],jurisdictions:[['CA-AB','Alberta']],copy:{id:'fixture-predecessor',jurisdiction:'CA-AB',classification:'Synthetic employee',settings:JSON.stringify(selected),source_url:reference.source,mandatory:0}});await tick();fillMetadata();
change(label('Vacation pay (%)').querySelector('input'),'8');await tick();assert.equal((await submit()).vacationPercent,'8');
change(label('Vacation pay (%)').querySelector('input'),'0');
change(label('Eligibility lookback').querySelector('input'),'0');
change(label('Regular-day lookback').querySelector('input'),'0');
change(label('Regular-day occurrences').querySelector('input'),'0');await tick();
let settings=await submit();assert.equal(settings.vacationPercent,'0');assert.equal(settings.eligibilityLookbackMonths,0);assert.equal(settings.regularDayLookbackWeeks,0);assert.equal(settings.regularDayMinimumOccurrences,0);assert.equal(settings.holidayWindowDays,28);assert.equal(settings.holidayDivisor,0);assert.equal(settings.holidayPayOnNonWorkday,false);assert.equal(w.saved.body.predecessor,'fixture-predecessor');assert.equal(suggested.vacationPercent,'4');assert.equal(suggested.eligibilityLookbackMonths,12);
for(const name of ['Eligibility lookback','Regular-day lookback','Regular-day occurrences'])change(label(name).querySelector('input'),'');await tick();settings=await submit();for(const key of ['eligibilityLookbackMonths','regularDayLookbackWeeks','regularDayMinimumOccurrences'])assert.equal(Object.hasOwn(settings,key),false);

// First non-Alberta setup may inherit before any employee override has been entered.
const policy={version:1,country:'IN',jurisdiction:'IN-DL',currency:'INR',classification:'Employee',frequency:'Monthly',workweekStart:1,regularWeekHours:40,workdays:[1,2,3,4,5],salaryProration:'Workdays',overtime:'Configured rule',dailyHours:0,weeklyHours:0,overtimeMultiplier:'',ruleSource:'https://labour.gov.in/',exemptionReason:'',vacationMode:'Each pay',vacationPercent:'',contractorMethod:'Hourly',taxEngine:'India statutory payroll',taxProfile:{federalClaim:'Basic',federalClaimAmount:'0',provincialClaim:'Basic',provincialClaimAmount:'0',cppExempt:false,eiExempt:false,cppMonths:12,additionalTax:'0',annualDeduction:'0',annualFederalCredit:'0',annualProvincialCredit:'0'},reviewed:false,reference:'Synthetic employee first-setup fixture'};
for(const blank of [true,false]){
 w.renderEmployee(blank?policy:{...policy,vacationPercent:'8',overtimeMultiplier:'2'});await tick();click('Setup');await tick();change(w.document.querySelector('.pay-person select'),'fixture-person');await tick();
 const disclosure=[...w.document.querySelectorAll('.pay-disclosure')].find(item=>item.querySelector('summary')?.textContent==='Save an employee payroll-policy version'),form=disclosure.querySelector('form');
 const source=form.querySelector('[name="policyValueSource"]'),vacation=form.querySelector('[name="vacationPercent"]');
 assert.equal(source.value,'Employee override');change(source,'Jurisdiction policy');await tick();assert.equal(vacation.disabled,true);
 form.querySelector('[name="effectiveOn"]').value='2026-12-01';form.querySelector('[name="note"]').value='Synthetic inheritance setup';form.querySelector('[name="reviewed"]').checked=true;
 assert.equal(form.checkValidity(),true);form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(w.saved.body.policy.policyValueSource,'Jurisdiction policy');assert.equal(w.saved.body.policy.companyConfigured,true);assert.equal(w.saved.body.policy.vacationPercent,blank?'':'8');assert.equal(w.saved.body.policy.overtimeMultiplier,blank?'':'2');
 change(source,'Employee override');await tick();assert.equal(vacation.disabled,false);assert.equal(vacation.value,blank?'':'8');
 change(vacation,'0');change(form.querySelector('[name="overtimeMultiplier"]'),'0');await tick();form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(w.saved.body.policy.vacationPercent,'0');assert.equal(w.saved.body.policy.overtimeMultiplier,'0');
}
assert.deepEqual(errors,[]);
w.close();
console.log('PASS company-policy DOM: national reference selection in both orders, jurisdiction/source retention, exact zero, immutable references, optional holiday controls, and first-setup/retained employee inheritance.');
