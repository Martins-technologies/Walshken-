"use client";
import {RetentionManagement,type RetentionData} from "./retention-management";
import {EmploymentManagement,type EmploymentManagementData} from "./employment-management";
import { useState } from "react";
import { staffActions } from "@/lib/walshken/staff-permissions";
import { initialJurisdictions } from "@/lib/walshken/jurisdiction-catalog";
import { roles, roleNames } from "@/lib/walshken/catalog";
import { ActionForm, Disclosure, Panel, Quick, Table, options, type RecordRow, type Field } from "./ui";

export type AuditFilters = {q?:string;query:string;employee?:string;administrator?:string;country?:string;department?:string;from:string;to:string;category:string;categories:string[];page:number;next:boolean};
const text = (name:string,label:string,type="text",required=true): Field => ({name,label,type,required});

export function StaffGovernance({rows,staff,units,notice,acknowledgements,policies,employment,scans,retention,refresh}: {
  retention?:RetentionData|null;scans:RecordRow[];employment?:EmploymentManagementData|null;rows:RecordRow[];staff:RecordRow[];units:RecordRow[];notice?:RecordRow|null;acknowledgements:RecordRow[];policies:RecordRow[];refresh:()=>void;
}) {
  const [principal,setPrincipal] = useState("employee");
  const [scope,setScope] = useState("organization");
  const internalRoles = roles.filter(role=>role!=="super_admin"&&role!=="guest").map(role=>[role,roleNames[role]] as const);
  return <>
    {employment&&<EmploymentManagement data={employment} refresh={refresh}/>}
    <Panel title="Scoped action permissions" note="An explicit denial takes precedence over a grant for the same action and employee.">
      <Disclosure title="Add or change a permission">
        <div className="table-filter">
          <label>Apply to<select value={principal} onChange={event=>setPrincipal(event.target.value)}><option value="employee">Employee</option><option value="role">Role</option></select></label>
          <label>Scope<select value={scope} onChange={event=>setScope(event.target.value)}><option value="organization">Organization</option><option value="department">Department</option><option value="division">Division</option><option value="employee">Individual employee</option>{employment&&<><option value="country">Employment country</option><option value="office">Office</option></>}</select></label>
        </div>
        <ActionForm key={principal+scope} path="governance/permission-save" extra={{principalType:principal,scopeType:scope}}
          fields={[
            {name:"principal",label:principal==="role"?"Role":"Employee",options:principal==="role"?internalRoles:options(staff.filter(row=>row.role!=="super_admin")),required:true},
            ...(scope==="organization"?[]:[{name:"scopeId",label:"Target",options:scope==="country"?([["CA","Canada"],["IN","India"],["PK","Pakistan"]] as const):options(scope==="employee"?staff:units.filter(row=>String(row.kind).toLowerCase()===scope)),required:true}]),
            {name:"capability",label:"Action",options:Object.entries(staffActions),required:true},
            {name:"effect",label:"Permission",options:[["allow","Allow"],["deny","Deny"]],required:true},
          ]} submit="Save permission" refresh={refresh}/>
      </Disclosure>
      <Table rows={rows} columns={[{key:"principal",title:"Assigned to"},{key:"scope",title:"Scope"},{key:"action",title:"Action"},{key:"effect",title:"Effect"}]}
        empty="No additional permissions" actions={row=><Quick path="governance/permission-remove" data={{id:row.id}} refresh={refresh}>Remove rule</Quick>}/>
    </Panel>
    <Panel title="Staff privacy notice" note="Publishing creates a dated version. Staff can read the current version and acknowledge it from My profile.">
      {notice&&<p><strong>{notice.title}</strong> · {String(notice.created_at).slice(0,10)}</p>}
      <Disclosure title="Publish a privacy notice"><ActionForm path="governance/notice-publish" fields={[text("title","Title"),text("body","Notice text","textarea")]} submit="Publish to staff" refresh={refresh}/></Disclosure>
      {notice&&<Table rows={acknowledgements} columns={[{key:"name",title:"Employee"},{key:"created_at",title:"Acknowledgement",render:row=>row.created_at?String(row.created_at).slice(0,10):"Pending"}]}/>}
    </Panel>
    <Panel title="Employment jurisdictions" note="Record applicable worksite rules and their effective dates. Verification records the evidence review. Pay calculations require a supported engine and payroll setup.">
      <Table rows={initialJurisdictions.map(region=>({...region,id:region.code}))} columns={[
        {key:"name",title:"Initial review region"},{key:"code",title:"Code"},{key:"engine",title:"Calculation coverage"},
        {key:"source",title:"Source",render:row=><a href={String(row.source)} target="_blank" rel="noreferrer">Official guidance</a>},
      ]}/>
      <Disclosure title="Add a jurisdiction evidence version"><ActionForm path="governance/jurisdiction-save" fields={[
        {name:"country",label:"Country",options:[["CA","Canada"],["IN","India"],["PK","Pakistan"]],required:true},
        text("jurisdiction","Employment jurisdiction code"),text("classification","Covered establishment and employee category"),
        text("version","Version"),text("effectiveFrom","Effective from","date"),text("effectiveThrough","Effective through","date"),
        text("source","Official source URL","url"),text("evidence","Applicable rules and evidence","textarea"),
      ]} submit="Save evidence version" refresh={refresh}/></Disclosure>
      <Table rows={policies} columns={[
        {key:"jurisdiction",title:"Jurisdiction"},{key:"classification",title:"Coverage"},{key:"version",title:"Version"},
        {key:"effective_from",title:"Starts"},{key:"effective_through",title:"Ends"},{key:"status",title:"Review status"},
      ]} empty="No jurisdiction evidence versions"/>
      {policies.map(row=><Disclosure key={row.id} title={`${row.jurisdiction} · ${row.version} · ${row.status}`}>
        <p>{row.evidence}</p><p><a href={String(row.source_url)} target="_blank" rel="noreferrer">Open cited source</a></p>
        <p>Recorded by {row.author}{row.verifier? ` · Reviewed by ${row.verifier}` : ""}</p>
        {row.decision_reason&&<p>{row.decision_reason}</p>}
        {row.status!=="Withdrawn"&&<ActionForm path="governance/jurisdiction-withdraw" extra={{id:row.id}} fields={[text("reason","Withdrawal reason")]} submit="Withdraw version" refresh={refresh}/>}
        {row.status==="Draft"&&<ActionForm path="governance/jurisdiction-verify" extra={{id:row.id}} fields={[text("reason","Independent verification reference")]} submit="Verify evidence" refresh={refresh}/>}
      </Disclosure>)}
    </Panel>
    {employment&&<Panel title="Upload security" note="Pending, failed and infected uploads remain private. A clean result is required before a file can be released.">
      <Table rows={scans} columns={[{key:'name',title:'Uploaded by'},{key:'file_name',title:'File'},{key:'created_at',title:'Received'},{key:'status',title:'Scan result'}]}/>
    </Panel>}
    {retention&&<RetentionManagement data={retention} refresh={refresh}/>}
    <Panel title="Administrator access">
      <Disclosure title="Appoint another Super Admin"><ActionForm path="governance/appoint-super" fields={[
        {name:"employee",label:"Current administrator",options:options(staff.filter(row=>row.role==="admin")),required:true},
        text("password","Your current password","password"),text("code","Fresh authenticator or recovery code"),
      ]} submit="Appoint Super Admin" refresh={refresh}/></Disclosure>
      <Disclosure title="Recover an employee’s lost authenticator">
        <p>Verify the employee’s identity before creating a recovery code. This revokes their existing password, sessions and authenticator and requires fresh enrollment.</p>
        <ActionForm path="governance/recover-mfa" fields={[
          {name:"employee",label:"Employee",options:options(staff),required:true},text("reason","Identity verification reference"),
          text("password","Your current password","password"),text("code","Fresh authenticator or recovery code"),
        ]} submit="Create one-time recovery code" refresh={refresh}/>
      </Disclosure>
    </Panel>
  </>;
}
