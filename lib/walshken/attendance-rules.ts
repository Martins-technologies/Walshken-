import {fail} from './server';
import {localDate,workSeconds} from './work';
export const albertaRules={jurisdiction:'CA-AB',category:'Standard adult employee',source:'https://www.alberta.ca/hours-work-rest',verifiedOn:'2026-11-23',maxShiftMinutes:720,minRestMinutes:480,changeNoticeMinutes:1440};
export type BreakOption={key:string;label:string;minutes:number;paid:boolean;afterMinutes:number};
export type WorkPolicy={version:1;rules:typeof albertaRules;breaks:BreakOption[];splitAgreement:boolean;restricted:boolean;manualAllowed:boolean;lateGrace:number;earlyGrace:number};
export type WorkBreak={id?:string;starts_at:string;ends_at:string|null;paid:number;kind?:string;restricted?:number;voided_at?:string|null};
export function minimumBreaks(seconds:number){return seconds>=36000?2:seconds>18000?1:0;}
export function defaultPolicy(paid=false):WorkPolicy{return {version:1,rules:albertaRules,breaks:[{key:'lunch',label:'Lunch',minutes:30,paid,afterMinutes:300},{key:'rest',label:'Rest break',minutes:30,paid,afterMinutes:600}],splitAgreement:false,restricted:false,manualAllowed:false,lateGrace:0,earlyGrace:0};}
export function validatePolicy(value:unknown):WorkPolicy{
 if(!value||typeof value!=='object')return fail(400,'Provide a break policy.');const v=value as WorkPolicy;
 if(!Array.isArray(v.breaks)||v.breaks.length<1||v.breaks.length>10)return fail(400,'Configure one to ten break types.');
 const used=new Set<string>();const breaks=v.breaks.map(b=>{if(!b||!/^[a-z][a-z0-9-]{0,30}$/.test(b.key)||used.has(b.key)||typeof b.label!=='string'||!b.label.trim()||b.label.length>80||!Number.isInteger(b.minutes)||b.minutes<1||b.minutes>120||!Number.isInteger(b.afterMinutes)||b.afterMinutes<0||b.afterMinutes>720||typeof b.paid!=='boolean')return fail(400,'Each break needs a unique key, label, duration (1–120 minutes), paid setting and start offset.');used.add(b.key);return {...b,label:b.label.trim()};});
 if(v.splitAgreement===true)return fail(400,'This standard policy requires uninterrupted statutory 30-minute rests. Additional paid 15-minute breaks may be added.');
 const p:WorkPolicy={version:1,rules:albertaRules,breaks,splitAgreement:false,restricted:v.restricted===true,manualAllowed:v.manualAllowed===true,lateGrace:Number(v.lateGrace??0),earlyGrace:Number(v.earlyGrace??0)};
 if(![p.lateGrace,p.earlyGrace].every(n=>Number.isInteger(n)&&n>=0&&n<=60))return fail(400,'Attendance indicator grace must be 0–60 minutes.');
 for(const span of [19800,36000,43200])validatePlannedBreaks(p,span);
 return p;
}
export function validatePlannedBreaks(policy:WorkPolicy,span:number){
 const required=minimumBreaks(span);if(!required)return;
 const min=policy.splitAgreement?15:30;
 const eligible=policy.breaks.filter(b=>b.minutes>=min).map((b,i)=>({...b,index:i,offset:Math.max(0,Math.min(b.afterMinutes,span/60-b.minutes))})).sort((a,b)=>a.offset-b.offset);
 let firstMinutes=0;const used=new Set<number>();for(const b of eligible){if(b.offset<=300&&firstMinutes<30){firstMinutes+=Math.min(30,b.minutes);used.add(b.index);}}
 const laterMinutes=eligible.filter(b=>!used.has(b.index)&&b.offset>=300).reduce((n,b)=>n+Math.min(30,b.minutes),0);
 if(firstMinutes<30||required===2&&laterMinutes<30)return fail(400,'Alberta minimums require a 30-minute rest around the first five hours and another distinct 30-minute rest for shifts of ten hours or longer. Split periods need agreement and must be at least 15 minutes.');
}
export function iso(value:unknown,label='time'){const v=typeof value==='string'?value:'';if(!/(Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))return fail(400,`Choose a valid ${label} with a time-zone offset.`);return new Date(v).toISOString();}
export function zone(value:unknown){const v=String(value??'');try{new Intl.DateTimeFormat('en',{timeZone:v}).format();return v;}catch{return fail(400,'Choose a valid IANA time zone.');}}
export function localWall(instant:string,timeZone:string){if(['America/Edmonton','Canada/Mountain'].includes(timeZone)&&Date.parse(instant)>=Date.parse('2026-11-01T00:00:00Z'))timeZone='Etc/GMT+6';const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));const part=(k:string)=>parts.find(p=>p.type===k)?.value;return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;}
export function localInstant(value:unknown,timeZone:string,fold='earlier'){
 const wall=String(value??'');if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(wall))return fail(400,'Choose a local date and time.');const base=Date.parse(wall+'Z');if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,16)!==wall)return fail(400,'Invalid local date/time.');
 const matches=new Set<number>();for(const h of [-36,-12,0,12,36]){const guess=base+h*3600000,seen=Date.parse(localWall(new Date(guess).toISOString(),timeZone)+'Z'),candidate=base-(seen-guess);if(localWall(new Date(candidate).toISOString(),timeZone)===wall)matches.add(candidate);}
 const ordered=[...matches].sort((a,b)=>a-b);if(!ordered.length)return fail(400,'This local time does not exist because of daylight saving. Choose another time.');if(!['earlier','later'].includes(fold))return fail(400,'Choose earlier or later for a repeated daylight-saving hour.');return new Date(fold==='later'?ordered.at(-1)!:ordered[0]).toISOString();
}
export const dayAdd=(day:string,days:number)=>new Date(Date.parse(day+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
export function interval(start:string,end:string){const seconds=workSeconds(start,end);if(!seconds||seconds>86400)return fail(400,'A work entry must end after it starts and span at most 24 hours.');return seconds;}
export function totals(start:string,end:string,breaks:WorkBreak[]){const gross=workSeconds(start,end),active=breaks.filter(b=>!b.voided_at);const unpaid=active.filter(b=>!b.paid).reduce((sum,b)=>sum+Math.max(0,Math.floor((Math.min(Date.parse(end),Date.parse(b.ends_at??end))-Math.max(Date.parse(start),Date.parse(b.starts_at)))/1000)),0),breakSeconds=active.reduce((sum,b)=>sum+Math.max(0,Math.floor((Math.min(Date.parse(end),Date.parse(b.ends_at??end))-Math.max(Date.parse(start),Date.parse(b.starts_at)))/1000)),0);return {gross,unpaid,paid:Math.max(0,gross-unpaid),breakSeconds};}
export function compliance(start:string,end:string,breaks:WorkBreak[],policy:WorkPolicy){
 const span=workSeconds(start,end),issues:string[]=[];if(span>43200)issues.push('Recorded span exceeds Alberta’s standard twelve-hour limit.');const required=minimumBreaks(span),min=policy.splitAgreement?900:1800;
 const eligible=breaks.filter(b=>!b.voided_at&&b.ends_at&&workSeconds(b.starts_at,b.ends_at)>=min).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)),used=new Set<WorkBreak>();let firstSeconds=0;
 for(const b of eligible){if(Date.parse(b.starts_at)<=Date.parse(start)+18000000&&firstSeconds<1800){firstSeconds+=Math.min(1800,workSeconds(b.starts_at,b.ends_at!));used.add(b);}}
 const laterSeconds=eligible.filter(b=>!used.has(b)&&Date.parse(b.starts_at)>=Date.parse(start)+18000000).reduce((n,b)=>n+Math.min(1800,workSeconds(b.starts_at,b.ends_at!)),0);
 if(required&&firstSeconds<1800)issues.push('The first statutory 30-minute rest was missing, too short or started late.');if(required===2&&laterSeconds<1800)issues.push('The second statutory 30-minute rest was missing or too short.');
 if(breaks.some(b=>!b.voided_at&&b.restricted&&!b.paid))issues.push('A restricted break must be paid.');return issues;
}
export function dailySegments(start:string,end:string,breaks:WorkBreak[],timeZone:string){const rows=[];let cursor=start;for(let i=0;i<40&&cursor<end;i++){const day=localDate(cursor,timeZone),boundary=localInstant(dayAdd(day,1)+'T00:00',timeZone),until=boundary<end?boundary:end;rows.push({day,...totals(cursor,until,breaks)});cursor=until;}return rows;}
