import {employerValidationContext,validateNationalApplicability} from './employer-validation';
import {all,fail,one,type Actor,type Db} from './server';
import {applicablePolicy,employmentTermsOn} from './employment-engine';
import {canadaTaxPackages2026} from './payroll-canada-packages';
import {nationalTaxPackages} from './payroll-national-packages';
import {nationalPayroll,validateNationalElection,type NationalElection,type NationalTaxPackage} from './payroll-tax-national';
import {canadianAlbertaTax,type CanadaAlbertaParameters,type CanadaTaxInput} from './payroll-tax-ca';
import {payrollDataset,hash,type PayrollEmployee} from './payroll-access';
import {fiscalYear,remainingFiscalPeriods} from './payroll-fiscal';
import {D} from './payroll-money';
import type {PayLine,PayPeriod,PayPolicy} from './payroll-types';
export const enterpriseEnabled=()=>process.env.WALSHKEN_ENTERPRISE_WORKFLOWS_ENABLED==='1';
export const nativeEngines=['Canada jurisdiction engine','India statutory payroll','Pakistan statutory payroll'] as const;
export async function statutoryContext(db:Db,actor:Actor,employee:PayrollEmployee,p:PayPeriod,policy:PayPolicy){
 if(!nativeEngines.includes(policy.taxEngine as typeof nativeEngines[number]))return null;
 if(!enterpriseEnabled())return fail(404,'Country statutory payroll is not enabled on this release.');
 const employer=await employerValidationContext(db,actor,employee,p,policy);
 const country=policy.country,terms=await employmentTermsOn(db,employee,p.pay_date),region=country==='CA'?String(policy.taxProfile.native?.taxProvince??terms?.region_code??employee.jurisdiction).replace(/^CA-/,''):'';
 const category=country==='CA'?'Canada payroll':country==='IN'?'India payroll':'Pakistan payroll';
 const active=await applicablePolicy(db,employee,p.pay_date,category,false,country==='CA'?'CA-'+region:undefined);
 if(country==='CA'){
  const parameters=(active?.settings??canadaTaxPackages2026().find(r=>r.region?.code===region&&p.pay_date>=r.validFrom&&p.pay_date<=r.validThrough)) as CanadaAlbertaParameters|undefined;
  if(!parameters||parameters.region?.code!==region)return fail(409,'Choose the actual tax province and activate its verified payment-date rule package.');
  return {employer,country,parameters,versionId:active?.row.id??parameters.version,election:null,input:null,ledger:[],fiscal:fiscalYear(country,p.pay_date)};
 }
 const latest=await one<{id:string;configuration:string;configuration_hash:string;decision:string|null}>(db,`SELECT i.*,r.decision FROM staff_statutory_inputs i LEFT JOIN staff_statutory_input_reviews r ON r.input_id=i.id
  WHERE i.org_id=? AND i.employee_id=? AND i.period_id=? AND i.release_stage=? ORDER BY i.created_at DESC,i.id DESC LIMIT 1`,actor.org_id,employee.id,p.id,payrollDataset());
 if(!latest||latest.decision!=='Approved')return fail(409,'Record and independently approve the country-specific statutory inputs for this employee and pay period.');
 const raw=JSON.parse(latest.configuration);if(hash(raw)!==latest.configuration_hash)return fail(409,'Statutory-input integrity verification failed.');
 const parameters=(active?.settings??nationalTaxPackages().find(r=>r.country===country&&r.regime===raw.regime&&p.pay_date>=r.validFrom&&p.pay_date<=r.validThrough)) as NationalTaxPackage|undefined;
 if(!parameters||parameters.country!==country||parameters.currency!==policy.currency)return fail(409,'Activate the applicable fiscal-year statutory package. A previous year is never rolled forward.');
 const election=validateNationalElection(raw,parameters);if(employer)validateNationalApplicability(employer,election,parameters,p);const fiscal=fiscalYear(country,p.pay_date);
 const ledger=await all<{id:string;contribution_month:string;code:string;basis_minor:number;employee_minor:number;employer_minor:number}>(db,'SELECT id,contribution_month,code,basis_minor,employee_minor,employer_minor FROM staff_contribution_ledger WHERE org_id=? AND employee_id=? AND release_stage=? AND tax_year=? ORDER BY contribution_month,id',actor.org_id,employee.id,payrollDataset(),fiscal.year);
 return {employer,country,parameters,versionId:active?.row.id??parameters.version,election,input:latest,ledger,fiscal};
}
export function nativeStatutoryTax(context:NonNullable<Awaited<ReturnType<typeof statutoryContext>>>,input:CanadaTaxInput,p:PayPeriod,policy:PayPolicy,lines:PayLine[]){
 if(context.country==='CA'){const parameters=structuredClone(context.parameters) as CanadaAlbertaParameters;if(context.employer?.employer.configuration.canada)parameters.eiEmployerMultiplier=context.employer.employer.configuration.canada.eiEmployerMultiplier;return canadianAlbertaTax(input,parameters);}
 const e=context.election!,priorMonthly:{[key:string]:{basis:number;employee:number;employer:number}}={},priorAnnual:{[key:string]:{basis:number;employee:number;employer:number}}={};
 for(const row of context.ledger){const mkey=row.contribution_month+':'+row.code,m=priorMonthly[mkey]??{basis:0,employee:0,employer:0},a=priorAnnual[row.code]??{basis:0,employee:0,employer:0};for(const [key,col] of [['basis','basis_minor'],['employee','employee_minor'],['employer','employer_minor']] as const){m[key]+=Number(row[col]);a[key]+=Number(row[col]);}priorMonthly[mkey]=m;priorAnnual[row.code]=a;}
 const calendarMonths=new Map<string,{days:number;gross:number;taxable:number;basic:number}>();
 for(let day=p.starts_on;day<=p.ends_on;day=new Date(Date.parse(day+'T12:00Z')+86400000).toISOString().slice(0,10)){const k=day.slice(0,7),row=calendarMonths.get(k)??{days:0,gross:0,taxable:0,basic:0};row.days++;calendarMonths.set(k,row);}
 // Dated hourly/adjustment lines retain their real earning month. Period salary is
 // allocated by its contractual calendar/workday proration, with remainder reconciliation.
 const amounts=lines.filter(l=>!l.included&&l.kind!=='Deduction');
 for(const l of amounts){if(l.date&&l.kind!=='Salary'&&l.kind!=='Contract fee'){const row=calendarMonths.get(l.date.slice(0,7));if(row){row.gross+=l.amount;if(l.taxable)row.taxable+=l.amount;continue;}}
  const weights=[...calendarMonths].map(([month,row])=>({month,weight:policy.salaryProration==='Calendar days'?row.days:Array.from({length:31},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`).filter(day=>day>=p.starts_on&&day<=p.ends_on&&Number(day.slice(8))<=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate()&&policy.workdays.includes(new Date(day+'T12:00Z').getUTCDay())).length}));
  const denominator=weights.reduce((n,r)=>n+r.weight,0)||1;let remaining=l.amount;
  weights.forEach((r,i)=>{const amount=i===weights.length-1?remaining:new D(l.amount).mul(r.weight).div(denominator).toDecimalPlaces(0).toNumber();remaining-=amount;const target=calendarMonths.get(r.month)!;target.gross+=amount;if(l.taxable)target.taxable+=amount;});
 }
 const gross=amounts.reduce((n,l)=>n+l.amount,0),entries=[...calendarMonths.entries()];let basicRemaining=new D(e.basicPay).mul(100).toDecimalPlaces(0).toNumber();
 const segments=entries.map(([month,row],i)=>{const basic=e.basicPercent!==undefined?new D(Math.max(0,row.gross)).mul(e.basicPercent).div(100).toDecimalPlaces(0).toNumber():i===entries.length-1?basicRemaining:new D(e.basicPay).mul(100).mul(Math.max(0,row.gross)).div(gross||1).toDecimalPlaces(0).toNumber();if(e.basicPercent===undefined)basicRemaining-=basic;return {month,gross:row.gross,taxable:row.taxable,basic};});
 if(context.country==='IN'&&context.employer){const minimum=new D(context.employer.facts.india!.minimumBasicPercent);if(segments.some(s=>new D(s.basic).lt(new D(s.gross).mul(minimum).div(100))))return fail(409,'The actual contributory wage allocation is below the independently reviewed statutory wage-definition minimum.');}
 return nationalPayroll({panStatus:context.employer?.facts.india?.panStatus,payDate:p.pay_date,startsOn:p.starts_on,endsOn:p.ends_on,periods:p.periods_per_year,remainingPeriods:remainingFiscalPeriods(context.country,p.pay_date,p.frequency),gross,taxable:input.taxable,regular:input.taxable-input.bonus,ytdTaxable:input.ytd.taxable,ytdTax:input.ytd.federal,priorMonthly,priorAnnual,election:e,segments},context.parameters as NationalTaxPackage);
}
