import type {Actor} from './server';
export const controlsEnabled=()=>process.env.WALSHKEN_WORKFLOW_CONTROLS_ENABLED==='1';
export const capabilities={
 'attendance.manage':'Review team attendance and reports','attendance.policy':'Set effective break and attendance policies','attendance.correct':'Approve attendance corrections','timesheets.approve':'Approve timesheets','schedules.manage':'Create and publish schedules','leave.approve':'Approve leave and absences','payroll.prepare':'Prepare payroll, rates and earnings','payroll.approve':'Approve payroll and earnings','payroll.finalize':'Finalize approved payroll','payroll.pay':'Record payroll payments','holidays.manage':'Manage holiday assignments and company observances','holidays.evidence':'Review holiday evidence and assessments'
} as const;
export type Capability=keyof typeof capabilities;
export type OperatingAuthority={permission:Capability;allowed:boolean;scope:'Assigned'|'Organization'};
export function allowed(actor:Actor,key:Capability){
 if(actor.role==='super_admin')return true;
 if(actor.role==='guest')return false;
 const grant=controlsEnabled()?actor.authorities?.find(a=>a.permission===key):undefined;
 if(grant)return grant.allowed;
 if(key.startsWith('payroll.')||key==='holidays.evidence')return actor.role==='hr';
 if(['attendance.policy','attendance.correct','holidays.manage'].includes(key))return ['admin','hr'].includes(actor.role);
 return ['admin','hr','manager'].includes(actor.role);
}
export function organizationAuthority(actor:Actor,domain:'workforce'|'payroll'|'holidays'){
 if(actor.role==='super_admin')return true;
 if(!controlsEnabled())return false;
 const keys=domain==='workforce'?['attendance.','timesheets.','schedules.','leave.']:domain==='payroll'?['payroll.']:['holidays.'];
 return actor.authorities?.some(a=>a.allowed&&a.scope==='Organization'&&keys.some(k=>a.permission.startsWith(k)))??false;
}
export function hasWorkAuthority(actor:Actor){return (Object.keys(capabilities) as Capability[]).some(k=>!k.startsWith('payroll.')&&allowed(actor,k));}
