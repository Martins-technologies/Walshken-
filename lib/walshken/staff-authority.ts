import {permissionScope,staffReadinessEnabled,type StaffAction} from './staff-permissions';
import {canManage,canPayroll,canSuper,fail,one,scope,type Actor,type Db} from './server';

type Clause={sql:string;args:unknown[]};
const ownActions=new Set<StaffAction>(['people.read','attendance.read','attendance.edit','leave.read','leave.manage','shifts.read','timesheets.read','payroll.read','payroll.salary','payroll.payslips','payroll.export','payroll.audit']);
const personnelAdmin=new Set<StaffAction>(['attendance.corrections','attendance.policy','people.edit','people.employment','people.sensitive','people.documents','people.status','people.compensation']);
const managers=new Set<StaffAction>(['people.read','attendance.read','attendance.edit','attendance.approve','shifts.read','timesheets.read','leave.read','leave.manage','leave.approve','shifts.manage']);
const superOnlyDefault=new Set<StaffAction>(['people.create','people.jurisdiction','payroll.providers','privacy.manage','privacy.export','privacy.dispose','audit.read','audit.export','security.scans']);

export function actionScope(actor:Actor,action:StaffAction,alias='e',includeSelf=true):Clause {
 if(canSuper(actor))return {sql:'1=1',args:[]};
 let fallback:Clause={sql:'1=0',args:[]};
 if(action.startsWith('payroll.')||action==='people.compensation'){
  if(canPayroll(actor))fallback=scope(actor,alias,includeSelf);
 }else if(managers.has(action)&&canManage(actor)||personnelAdmin.has(action)&&['admin','hr'].includes(actor.role))fallback=scope(actor,alias,includeSelf);
 if(superOnlyDefault.has(action))fallback={sql:'1=0',args:[]};
 if(includeSelf&&ownActions.has(action))fallback={sql:`(${fallback.sql}) OR ${alias}.id=?`,args:[...fallback.args,actor.id]};
 return staffReadinessEnabled()?permissionScope(actor.permissions??[],action,alias,fallback):fallback;
}

export async function requireEmployeeAction(db:Db,actor:Actor,action:StaffAction,target:string,includeSelf=true){
 const s=actionScope(actor,action,'e',includeSelf);
 if(!await one(db,`SELECT e.id FROM employees e WHERE e.org_id=? AND e.id=? AND e.role<>'guest' AND (${s.sql})`,actor.org_id,target,...s.args))return fail(403,'This action is outside your authorized employee scope.');
}
export function hasAction(actor:Actor,action:StaffAction){
 if(canSuper(actor))return true;
 const rules=actor.permissions??[];
 if(rules.some(r=>r.action===action&&r.effect==='deny'&&r.scope_type==='organization'))return false;
 return rules.some(r=>r.action===action&&r.effect==='allow')
  || ownActions.has(action)
  || !superOnlyDefault.has(action)&&(action.startsWith('payroll.')&&canPayroll(actor)||managers.has(action)&&canManage(actor)||personnelAdmin.has(action)&&['admin','hr'].includes(actor.role));
}
export async function requireOrganizationAction(db:Db,actor:Actor,action:StaffAction){
 if(canSuper(actor))return;
 const s=actionScope(actor,action,'e',false);
 if(await one(db,`SELECT e.id FROM employees e WHERE e.org_id=? AND e.role<>'guest' AND NOT COALESCE((${s.sql}),false) LIMIT 1`,actor.org_id,...s.args))return fail(403,'Organization-wide authority for this action is required.');
 if(!await one(db,'SELECT id FROM employees WHERE org_id=? LIMIT 1',actor.org_id))return fail(403,'Organization authority is unavailable.');
}
