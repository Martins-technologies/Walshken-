import type {CanadaAlbertaParameters} from "./payroll-tax-ca";
import {D} from "./payroll-money";
import {fail,integer,str} from "./server";
import type {EmploymentCategory} from "./employment-catalog";

export type WorkSettings = {
 maxShiftMinutes:number; minRestMinutes:number; changeNoticeMinutes:number; restHoursPerWeek:number;
 firstBreakAfterMinutes:number; secondBreakFromMinutes:number; minimumBreakMinutes:number; minimumSplitMinutes:number;
};
export type OvertimeSettings = {dailyHours:number;weeklyHours:number;multiplier:string;weekStart:number};
export type LeaveSettings = {workdays:number[];dayMinutes:number;yearStartMonth:number;proration:"None"|"Daily";categories:{code:string;name:string;paid:boolean;annualMinutes:number;carryMinutes:number;accrual:"Annual"|"Monthly";minimumServiceDays:number}[]};
export type HolidaySettings = {dates:{date:string;name:string;required:boolean}[]};
export type PolicySettings = WorkSettings|OvertimeSettings|LeaveSettings|HolidaySettings|CanadaAlbertaParameters;

export function validateEmploymentSettings(category:EmploymentCategory,input:unknown):PolicySettings|null {
 if(category==="Evidence")return null;
 if(typeof input!=="object"||input===null||Array.isArray(input))return fail(400,"Provide a complete policy configuration.");
 const v=input as Record<string,unknown>;
 if(category==="Canada Alberta payroll")return validateCanadaTaxParameters(v);
 if(category==="Work") {
  const settings:WorkSettings={
   maxShiftMinutes:integer(v.maxShiftMinutes,"maximum shift minutes",1,1440),
   minRestMinutes:integer(v.minRestMinutes,"minimum rest minutes",0,2880),
   changeNoticeMinutes:integer(v.changeNoticeMinutes,"schedule change notice minutes",0,43200),
   restHoursPerWeek:integer(v.restHoursPerWeek,"weekly rest hours",0,168),
   firstBreakAfterMinutes:integer(v.firstBreakAfterMinutes,"continuous work before first break",1,1440),
   secondBreakFromMinutes:integer(v.secondBreakFromMinutes,"second break threshold minutes",1,2880),
   minimumBreakMinutes:integer(v.minimumBreakMinutes,"minimum break minutes",1,120),
   minimumSplitMinutes:integer(v.minimumSplitMinutes,"minimum split break minutes",1,120),
  };
  if(settings.secondBreakFromMinutes<settings.firstBreakAfterMinutes||settings.minimumSplitMinutes>settings.minimumBreakMinutes)return fail(400,"Check the ordered break thresholds and split-break duration.");
  return settings;
 }
 if(category==="Overtime") {
  const multiplier=str(v.multiplier,"overtime multiplier",20);
  if(!/^\d+(\.\d{1,4})?$/.test(multiplier)||new D(multiplier).lt(1)||new D(multiplier).gt(10))return fail(400,"Enter an overtime multiplier from 1 to 10.");
  return {dailyHours:integer(v.dailyHours,"daily overtime threshold",1,24),weeklyHours:integer(v.weeklyHours,"weekly overtime threshold",1,168),multiplier,weekStart:integer(v.weekStart,"workweek first day",0,6)};
 }
 if(category==="Holiday calendar") {
  if(!Array.isArray(v.dates)||v.dates.length>500)return fail(400,"Provide up to 500 dated holidays.");
  const seen=new Set<string>();
  return {dates:v.dates.map(d=>{
   if(!d||typeof d!=="object")return fail(400,"Invalid holiday entry.");
   const date=str(d.date,"holiday date",10);
   if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date+"T12:00Z").toISOString().slice(0,10)!==date||seen.has(date))return fail(400,"Holiday dates must be valid and unique.");
   seen.add(date);
   if(typeof d.required!=="boolean")return fail(400,"Mark each date as statutory or optional.");
   return {date,name:str(d.name,"holiday name",180),required:d.required};
  })};
 }
 if(!Array.isArray(v.categories)||!v.categories.length||v.categories.length>30)return fail(400,"Provide one to thirty leave categories.");
 const codes=new Set<string>();
 if(!Array.isArray(v.workdays)||!v.workdays.length||v.workdays.length>7||v.workdays.some(day=>!Number.isInteger(day)||day<0||day>6)||!["None","Daily"].includes(String(v.proration)))return fail(400,"Configure working weekdays and the explicit leave proration method.");
 return {workdays:[...new Set(v.workdays)],dayMinutes:integer(v.dayMinutes,"normal leave day minutes",1,1440),yearStartMonth:integer(v.yearStartMonth,"leave year start month",1,12),proration:v.proration as 'None'|'Daily',categories:v.categories.map(c=>{
  if(!c||typeof c!=="object"||!/^[-A-Z0-9_]{2,30}$/.test(c.code)||codes.has(c.code)||typeof c.paid!=="boolean"||!["Annual","Monthly"].includes(c.accrual))return fail(400,"Enter unique leave codes and valid paid/accrual settings.");
  codes.add(c.code);
  return {code:c.code,name:str(c.name,"leave category name",100),paid:c.paid,
   annualMinutes:integer(c.annualMinutes,"annual leave minutes",0,525600),carryMinutes:integer(c.carryMinutes,"carry-forward minutes",0,525600),
   accrual:c.accrual,minimumServiceDays:integer(c.minimumServiceDays,"minimum service days",0,3650)};
 })};
}

function validateCanadaTaxParameters(v:Record<string,unknown>):CanadaAlbertaParameters {
 const year=integer(v.year,"Canadian tax year",2026,2100);
 if(v.validFrom!==year+"-01-01"||v.validThrough!==year+"-12-31")return fail(400,"An annual tax version must explicitly cover its calendar year.");
 const result={...v,year,version:str(v.version,"tax parameter version",100),source:str(v.source,"tax source",1500),validFrom:String(v.validFrom),validThrough:String(v.validThrough)} as CanadaAlbertaParameters;
 for(const key of ["ympe","yampe","cpp2Max","bpaMax","bpaMin","abClaim","cea","cppExemption","bpaPhaseStart","bpaPhaseEnd","abSupplementThreshold","bonusFlatThreshold"] as const)result[key]=integer(v[key],key,0,10_000_000);
 for(const key of ["cppRate","cppBaseRate","eiRate","cppMax","eiMax","cpp2Rate","eiEmployerMultiplier","abSupplementRate","bonusFlatRate"] as const){
  const raw=str(v[key],key,30);
  if(!/^(?:\d+|\d*\.\d{1,8})$/.test(raw)||new D(raw).lt(0)||new D(raw).gt(key.endsWith('Rate')?1:key==='eiEmployerMultiplier'?5:10000000))return fail(400,"Invalid tax rate or annual maximum.");
  result[key]=raw;
 }
 if(result.ympe<=result.cppExemption||result.bpaPhaseEnd<=result.bpaPhaseStart||result.yampe<result.ympe||new D(result.cppRate).lte(0)||new D(result.cppBaseRate).gt(result.cppRate)||result.bpaMin>result.bpaMax)return fail(400,"Canadian tax-year limits are inconsistent.");
 if(!result.source.startsWith('https://www.canada.ca/'))return fail(400,"Canadian native tax parameters require an official CRA source.");
 for(const key of ["federalBrackets","provincialBrackets"] as const){
  const input=v[key];
  if(!Array.isArray(input)||input.length<2||input.length>10)return fail(400,"Enter the full supported federal and Alberta bracket tables.");
  let previous=-1;
  result[key]=input.map(row=>{
   if(!Array.isArray(row)||row.length!==3)return fail(400,"Each bracket contains threshold, rate and offset.");
   const threshold=integer(row[0],"annual bracket threshold",0,10000000),offset=integer(row[2],"tax bracket offset",0,10000000),rate=String(row[1]);
   if(threshold<=previous||previous===-1&&threshold!==0||!/^\d*\.?\d+$/.test(rate)||new D(rate).lt(0)||new D(rate).gt(1))return fail(400,"Tax thresholds must increase from zero and rates must be decimal fractions.");
   previous=threshold;
   return [threshold,rate,offset] as [number,string,number];
  });
 }
 return result;
}
