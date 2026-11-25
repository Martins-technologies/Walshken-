import {D} from './payroll-money';
import {canadaTaxPackages2026} from './payroll-canada-packages';
import {canada2026} from './payroll-tax-ca';
import {nationalTaxPackages} from './payroll-national-packages';
import {albertaStandard} from './employment-rule-catalog';
import {canPayroll,canSuper,fail,one,type Actor,type Db} from './server';
import type {EmploymentCategory} from './employment-catalog';
import type {PayStandards} from './employment-settings';

export const financePolicyCategories:EmploymentCategory[]=['Pay standards','Overtime','Leave','Canada Alberta payroll','Canada payroll','India payroll','Pakistan payroll'];

// A shared jurisdiction policy affects every employee using that policy. An
// employee/department grant must never accidentally become a country-wide grant.
export async function financePolicyCountries(db:Db,actor:Actor):Promise<string[]> {
 if(canSuper(actor))return ['CA','IN','PK'];
 if(!['admin','hr'].includes(actor.role))return [];
 const permissions=(actor.permissions??[]).filter(r=>r.action==='payroll.rules');
 const denies=(actor.permissions??[]).filter(r=>(r.action==='payroll.rules'||r.action==='payroll.prepare')&&r.effect==='deny');
 if(denies.some(r=>r.scope_type!=='country'))return [];
 const delegated=canPayroll(actor)&&await one(db,'SELECT id FROM payroll_permissions WHERE org_id=? AND employee_id=? AND release_stage=? AND organization_access=1',actor.org_id,actor.id,process.env.WALSHKEN_PAYROLL_DATASET==='preview'?'preview':'production');
 const organization=Boolean(delegated)||permissions.some(r=>r.effect==='allow'&&r.scope_type==='organization');
 return ['CA','IN','PK'].filter(country=>!denies.some(r=>r.scope_id===country)&&(organization||permissions.some(r=>r.effect==='allow'&&r.scope_type==='country'&&r.scope_id===country)));
}
export async function requireFinancePolicyCountry(db:Db,actor:Actor,country:string,category:string) {
 if(!financePolicyCategories.includes(category as EmploymentCategory)||(await financePolicyCountries(db,actor)).includes(country)===false)return fail(403,'A payroll-rules grant for this country or the organization is required to manage its shared finance policies.');
}

export type FinancePolicySuggestion={id:string;country:string;jurisdiction:string;category:EmploymentCategory;classification:string;version:string;source:string;effectiveFrom:string;effectiveThrough:string;settings:Record<string,unknown>};
export function financePolicySuggestions(countries:string[]):FinancePolicySuggestion[]{
 const standard=albertaStandard;
 const standards:PayStandards={currency:'CAD',minimumHourly:String(standard.minimumHourlyMinor/100),minimumMonthly:'0',vacationPercent:standard.vacationInitialPercent,longServiceYears:standard.vacationLongServiceYears,longServiceVacationPercent:standard.vacationLongServicePercent,paymentDeadlineDays:standard.paymentDeadlineDays,holidayPremiumMultiplier:standard.holidayPremiumMultiplier,holidayMethod:'Average worked day',holidayWindowDays:standard.holidayAverageWageDays,holidayWindowBasis:'Before holiday',holidayDivisor:0,holidayPayOnNonWorkday:false,holidayPercent:'0',minimumServiceDays:0,minimumWorkedDays:standard.holidayMinimumWorkdays,eligibilityLookbackMonths:standard.holidayLookbackMonths,regularDayLookbackWeeks:standard.holidayRegularDayWeeks,regularDayMinimumOccurrences:standard.holidayRegularDayOccurrences,reportingHours:3,reportingRate:'Minimum wage'};
 const common={country:'CA',jurisdiction:'CA-AB',classification:'Standard adult employee',effectiveFrom:standard.effectiveFrom,effectiveThrough:standard.effectiveThrough};
 const suggestions:FinancePolicySuggestion[]=[
  {...common,id:'CA-AB-pay-standards',category:'Pay standards',version:standard.version,source:'https://www.alberta.ca/vacation-pay',settings:{...standards}},
  {...common,id:'CA-AB-overtime',category:'Overtime',version:standard.version,source:'https://www.alberta.ca/overtime-hours-overtime-pay',settings:{dailyHours:standard.dailyOvertimeHours,weeklyHours:standard.weeklyOvertimeHours,multiplier:standard.overtimeMultiplier,weekStart:1}},
  {...common,id:canada2026.version,category:'Canada Alberta payroll',version:canada2026.version,source:canada2026.source,effectiveFrom:canada2026.validFrom,effectiveThrough:canada2026.validThrough,settings:{...canada2026}},
  ...canadaTaxPackages2026().map(p=>({id:p.version,country:'CA',jurisdiction:'CA-'+p.region!.code,category:'Canada payroll' as const,classification:'Standard employee',version:p.version,source:p.source,effectiveFrom:p.validFrom,effectiveThrough:p.validThrough,settings:{...p,region:p.region?.code==='QC'?{...p.region,qpInsurableMax:new D(p.region.qpMax!).div(p.region.qpRate!).toFixed(2),federalTaxMultiplier:'.835',bonusLowRate:'.07'}:p.region}})),
  ...nationalTaxPackages().map(p=>({id:p.version,country:p.country,jurisdiction:'',category:(p.country==='IN'?'India payroll':'Pakistan payroll') as EmploymentCategory,classification:'Standard employee',version:p.version,source:p.source,effectiveFrom:p.validFrom,effectiveThrough:p.validThrough,settings:{...p,...(p.country==='IN'?{missingPanRate:'0.20'}:{})}})),
 ];
 return suggestions.filter(s=>countries.includes(s.country));
}
