import { createHash } from "node:crypto";
import { assertClientCaseUnheld, clientCaseFor, notifyCaseStaff, staffCaseFor } from "./client-cases";
import { withClientDb } from "./client-feature";
import { notifyClient } from "./client-notifications";
import { inspectDocument,renderDocumentPage } from "./document-render";
import { scanBytes } from "./staff-delivery";
import { all, audit, fail, id, integer, json, now, one, pick, run, str, throttle, type Actor, type Db } from "./server";
import { clientDocumentBackend, cleanupPendingClientObjects, readClientObject, removeClientObject, storeClientObject, type ClientStorageBackend } from "./client-document-storage";
import { clientDocumentCategories, clientDocumentMaxSize, clientDocumentMimes, type ClientDocumentRow } from "./client-document-types";

type Viewer = {kind:"client";id:string;session:string}|{kind:"staff";id:string;session:string;actor:Actor};
type Case = NonNullable<Awaited<ReturnType<typeof clientCaseFor>>>;
type Document = {id:string;org_id:string;case_id:string;customer_id:string;request_id:string|null;category:string;description:string;review_status:string;deleted_at:string|null};
type Version = {id:string;version:number;document_id:string;filename:string;mime:string;byte_size:number;sha256:string;page_count:number;storage_key:string;storage_backend:ClientStorageBackend;retain_until:string};
type Policy = {revision:number;retain_days:number;client_download:boolean;policy_basis:string};
type Disposal = {id:string;org_id:string;case_id:string;customer_id:string;document_id:string;requested_by_staff:string|null;status:string};
export type ClientDocumentViewer = Viewer;
const administrator=(viewer:Viewer)=>viewer.kind==="staff"&&(viewer.actor.role==="super_admin"||viewer.actor.role==="admin");
const scope=(db:Db,viewer:Viewer,caseId:string,lock=false)=>viewer.kind==="staff"?staffCaseFor(db,viewer.actor,caseId,lock):clientCaseFor(db,viewer.id,caseId,lock);
const accountScope=async(db:Db,viewer:Viewer,caseId:string,lock=false):Promise<Case>=>{
  const row=await scope(db,viewer,caseId,lock);
  return row??fail(404,"The case is unavailable.");
};
const scoped=<T>(db:Db,viewer:Viewer,work:(tx:Db)=>Promise<T>)=>viewer.kind==="client"?withClientDb(db,viewer.id,work):work(db);
const docFilter=[ "d.id=?","d.case_id=?","d.org_id=?","d.customer_id=?" ].join(" AND ");
const caseArgs=(row:Case)=>[row.id,row.org_id,row.customer_id] as const;
const notice=(title:string,body:string,key:string)=>({type:"document" as const,title,body,href:"/customer/documents",dedupeKey:key});

async function policy(db:Db,org:string):Promise<Policy|null> {
  return one<Policy>(db,"SELECT revision,retain_days,client_download,policy_basis FROM client_document_policies WHERE org_id=? ORDER BY revision DESC LIMIT 1",org);
}
async function document(db:Db,row:Case,documentId:string) {
  const item=await one<Document>(db,`SELECT * FROM client_documents d WHERE ${docFilter}`,documentId,...caseArgs(row));
  if(!item)return fail(404,"The document is unavailable.");
  return item;
}
async function event(db:Db,viewer:Viewer,item:Document,action:string,detail="",version:string|null=null) {
  await run(db,`INSERT INTO client_document_events(id,org_id,case_id,customer_id,document_id,version_id,staff_id,action,detail,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,id(),item.org_id,item.case_id,item.customer_id,item.id,version,viewer.kind==="staff"?viewer.id:null,action,detail,now());
  if(viewer.kind==="staff"&&!["Previewed","Downloaded original"].includes(action))await audit(db,viewer.actor,"Client document "+action.toLowerCase(),"client document",item.id).run();
}

export async function listClientDocuments(db:Db,viewer:Viewer,caseId:string,target?:string) {
  const row=await accountScope(db,viewer,caseId),configuration=await policy(db,row.org_id);
  const docs=await all<ClientDocumentRow>(db,`SELECT d.id,d.category,d.description,d.request_id,d.review_status,d.created_at,d.deleted_at,
    v.id AS current_version_id,v.version,v.filename,v.page_count,v.byte_size,v.scan_status,v.submitted_at,v.retain_until,
    h.id AS hold_id,p.id AS disposal_id,p.status AS disposal_status
    FROM client_documents d JOIN LATERAL (
      SELECT * FROM client_document_versions WHERE document_id=d.id ORDER BY version DESC LIMIT 1
    ) v ON true LEFT JOIN client_document_holds h ON h.document_id=d.id AND h.released_at IS NULL
    LEFT JOIN LATERAL (SELECT id,status FROM client_document_disposals WHERE document_id=d.id ORDER BY requested_at DESC,id DESC LIMIT 1) p ON true
    WHERE d.case_id=? AND d.org_id=? AND d.customer_id=? ORDER BY d.created_at DESC,d.id LIMIT 200`,...caseArgs(row));
  const requests=await all(db,`SELECT id,title,instructions,due_on::text AS due_on,status FROM client_case_document_requests WHERE case_id=? AND org_id=? AND status<>'Cancelled'
    ORDER BY due_on NULLS LAST,created_at DESC LIMIT 200`,row.id,row.org_id);
  const item=target?await document(db,row,target):null;
  const history=item?await all(db,`SELECT id,version,filename,page_count,byte_size,scan_status,submitted_at,retain_until FROM client_document_versions
    WHERE document_id=? AND org_id=? ORDER BY version DESC`,item.id,row.org_id):[];
  const events=item&&viewer.kind==="staff"?await all(db,`SELECT id,version_id,action,detail,occurred_at,CASE WHEN staff_id IS NULL THEN 'Client' ELSE 'Staff' END AS actor_kind
    FROM client_document_events WHERE document_id=? AND org_id=? ORDER BY occurred_at DESC,id DESC LIMIT 100`,item.id,row.org_id):[];
  return json({documents:viewer.kind==="staff"?docs:docs.map(item=>({...item,hold_id:null,disposal_id:null})),requests,history,events,canManage:administrator(viewer),canConfigure:viewer.kind==="staff"&&viewer.actor.role==="super_admin",
    canDownload:administrator(viewer)||viewer.kind==="client"&&!!configuration?.client_download,
    policy:viewer.kind==="staff"&&viewer.actor.role==="super_admin"?configuration:null});
}

function validUploadName(name:string) {
  if(!/\.(pdf|jpe?g|png)$/i.test(name)||/[<>]/.test(name))return fail(400,"Choose a PDF, JPEG or PNG up to 3 MB.");
  return name;
}

async function checkedFile(db:Db,filename:string,bytes:Buffer) {
  const scanner=await one(db,"SELECT id FROM integrations WHERE id='malware-scanner' AND enabled=1");
  const deferred=!scanner&&process.env.WALSHKEN_CLIENT_MALWARE_SCANNING_REQUIRED==="0";
  if(!deferred&&await scanBytes(db,bytes)==="infected")return fail(422,"This file did not pass malware screening. It was not added to the case.");
  const inspected=await inspectDocument(validUploadName(filename),bytes);
  if(!clientDocumentMimes.includes(inspected.mime as typeof clientDocumentMimes[number])) return fail(400,"Choose a supported PDF, JPEG or PNG.");
  return {...inspected,scanStatus:deferred?"Scanning deferred":"Clean"};
}

async function uploadForm(request:Request) {
  const limit=clientDocumentMaxSize+16_384,length=Number(request.headers.get("content-length")??0);
  if(!Number.isFinite(length)||length>limit)return fail(413,"Each file must be 3 MB or smaller.");
  const type=request.headers.get("content-type"),reader=request.body?.getReader();
  if(!type?.startsWith("multipart/form-data;")||!reader)return fail(400,"Choose a file to upload.");
  const chunks:Uint8Array[]=[];
  let read=0;
  for(;;){
    const chunk=await reader.read();
    if(chunk.done)break;
    read+=chunk.value.length;
    if(read>limit){await reader.cancel();return fail(413,"Each file must be 3 MB or smaller.");}
    chunks.push(chunk.value);
  }
  try{return await new Response(Uint8Array.from(Buffer.concat(chunks)),{headers:{"Content-Type":type}}).formData();}
  catch{return fail(400,"Choose a file to upload.");}
}

export async function uploadClientDocument(db:Db,viewer:Viewer,request:Request) {
  if(viewer.kind!=="client")return fail(403,"Only the client can submit an original inside their case.");
  await throttle(db,`client-document-upload:${viewer.id}`,30,300_000);
  const form=await uploadForm(request);
  const caseId=str(form.get("case"),"case",80),row=await scoped(db,viewer,tx=>accountScope(tx,viewer,caseId));
  const newCaseDocument=!(form.get("document"));
  const documentId=newCaseDocument?id():str(form.get("document"),"document",80);
  const requirement=newCaseDocument?str(form.get("requirement"),"document requirement",80,false)||null:null;
  const category=newCaseDocument?pick(form.get("category"),clientDocumentCategories,"document category"):"";
  const description=newCaseDocument?str(form.get("description"),"description",1000,false):"";
  const file=form.get("file");
  if(!(file instanceof Blob)||!file.size||file.size>clientDocumentMaxSize)return fail(413,"Choose a file up to 3 MB.");
  const filename=validUploadName(str((file as File).name,"file name",150)),bytes=Buffer.from(await file.arrayBuffer());
  const uploadId=str(form.get("uploadId"),"upload request",80,false)||id(),fileDigest=createHash("sha256").update(bytes).digest("hex");
  const receipt=async(tx:Db)=>{
    const previous=await one<{document_id:string;sha256:string;version:number;category:string;description:string;request_id:string|null}>(tx,`SELECT v.document_id,v.sha256,v.version,d.category,d.description,d.request_id
      FROM client_document_versions v JOIN client_documents d ON d.id=v.document_id WHERE v.case_id=? AND v.org_id=? AND v.customer_id=? AND v.upload_nonce=?`,...caseArgs(row),uploadId);
    if(!previous)return null;
    if(previous.sha256!==fileDigest||(!newCaseDocument&&previous.document_id!==documentId)||
      (newCaseDocument&&(previous.version!==1||previous.category!==category||previous.description!==description||previous.request_id!==requirement)))
      return fail(409,"This upload was already used with different file details. Choose the file again.");
    return previous.document_id;
  };
  const known=await scoped(db,viewer,receipt);
  if(known)return json({ok:true,id:known,message:"Document was already submitted."});
  if(!newCaseDocument)await scoped(db,viewer,tx=>document(tx,row,documentId));
  const inspected=await checkedFile(db,filename,bytes);
  const versionId=id(),key=`walshken-client/${row.id}/${documentId}/${versionId}`,backend=clientDocumentBackend(),uploadedAt=now();
  await scoped(db,viewer,tx=>run(tx,"INSERT INTO client_upload_pending_objects(storage_key,org_id,customer_id,storage_backend,created_at) VALUES(?,?,?,?,?)",key,row.org_id,row.customer_id,backend,uploadedAt));
  try {
    if(backend==="preview-db")await scoped(db,viewer,tx=>storeClientObject(tx,row.org_id,row.customer_id,key,backend,bytes,inspected.mime));
    else await storeClientObject(db,row.org_id,row.customer_id,key,backend,bytes,inspected.mime);
    const duplicate=await scoped(db,viewer,async tx=>{
      const current=await accountScope(tx,viewer,caseId,true);
      const existing=await receipt(tx);
      if(existing)return existing;
      let item:Document;
      if(newCaseDocument){
        if(requirement&&!await one(tx,"SELECT id FROM client_case_document_requests WHERE id=? AND case_id=? AND org_id=? AND status IN ('Open','Submitted','Replacement requested')",requirement,current.id,current.org_id))return fail(409,"This document request is closed.");
        await run(tx,`INSERT INTO client_documents(id,org_id,case_id,customer_id,request_id,category,description,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,documentId,current.org_id,current.id,current.customer_id,requirement,category,description,uploadedAt,uploadedAt);
        item=await document(tx,current,documentId);
      }else{
        item=await document(tx,current,documentId);
        if(item.deleted_at||await one(tx,"SELECT id FROM client_document_disposals WHERE document_id=? AND status='Approved'",item.id))return fail(409,"This document is unavailable for replacement.");
        await run(tx,"UPDATE client_documents SET review_status='Submitted',updated_at=? WHERE id=?",uploadedAt,item.id);
      }
      const sequence=await one<{version:number}>(tx,"SELECT COALESCE(MAX(version),0)::int+1 AS version FROM client_document_versions WHERE document_id=?",item.id);
      const settings=await policy(tx,current.org_id);
      const retention=settings?.retain_days??365;
      const retainUntil=new Date(Date.parse(uploadedAt)+retention*86400000).toISOString();
      await run(tx,`INSERT INTO client_document_versions(id,org_id,case_id,customer_id,document_id,upload_nonce,version,filename,mime,byte_size,sha256,storage_key,storage_backend,page_count,scan_status,submitted_at,retain_until)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,versionId,current.org_id,current.id,current.customer_id,item.id,uploadId,sequence?.version??1,inspected.filename,inspected.mime,bytes.length,inspected.sha256,key,backend,inspected.pages,inspected.scanStatus,uploadedAt,retainUntil);
      if(item.request_id)await run(tx,"UPDATE client_case_document_requests SET status='Submitted',updated_at=? WHERE id=? AND org_id=? AND case_id=? AND status<>'Cancelled'",uploadedAt,item.request_id,current.org_id,current.id);
      await event(tx,viewer,item,newCaseDocument?"Uploaded":"Replaced",inspected.scanStatus,versionId);
      await notifyCaseStaff(tx,current,"Client document submitted",`A new document is ready to review for case ${current.reference}.`,versionId);
      await notifyClient(tx,viewer.id,notice("Document received",`Walshken received a document for case ${current.reference}.`,`upload:${versionId}`));
      await run(tx,"DELETE FROM client_upload_pending_objects WHERE storage_key=? AND org_id=?",key,current.org_id);
      return null;
    });
    if(duplicate)return json({ok:true,id:duplicate,message:"Document was already submitted."});
  } catch(error) {
    // If the transaction outcome is uncertain, leave the private object for a later reconciliation.
    try{
      if(!await scoped(db,viewer,tx=>one(tx,"SELECT id FROM client_document_versions WHERE storage_key=? AND org_id=?",key,row.org_id))){
        if(backend==="preview-db")await scoped(db,viewer,tx=>removeClientObject(tx,row.org_id,row.customer_id,key,backend));
        else await removeClientObject(db,row.org_id,row.customer_id,key,backend);
        await scoped(db,viewer,tx=>run(tx,"DELETE FROM client_upload_pending_objects WHERE storage_key=? AND org_id=?",key,row.org_id));
      }
    }catch{/* Scheduled cleanup keeps retrying inaccessible staged objects. */}
    throw error;
  }
  return json({ok:true,id:documentId,message:newCaseDocument?"Document submitted.":"Replacement submitted. The original is retained."},201);
}

async function documentVersion(db:Db,viewer:Viewer,caseId:string,docId:string,versionId:string,download:boolean) {
  const row=await accountScope(db,viewer,caseId),item=await document(db,row,docId);
  if(item.deleted_at||await one(db,"SELECT id FROM client_document_disposals WHERE document_id=? AND status IN ('Approved','Disposed')",docId))return fail(404,"The document is unavailable.");
  if(download&&!administrator(viewer)&&!(viewer.kind==="client"&&(await policy(db,row.org_id))?.client_download))return fail(403,"Your account is not authorized to download an original.");
  const version=await one<Version>(db,`SELECT * FROM client_document_versions WHERE org_id=? AND customer_id=? AND case_id=? AND document_id=? AND (?='' OR id=?)
    ORDER BY version DESC LIMIT 1`,item.org_id,item.customer_id,item.case_id,item.id,versionId,versionId);
  if(!version)return fail(404,"The document version is unavailable.");
  return {item,version};
}

export async function viewClientDocument(db:Db,viewer:Viewer,request:Request,mode:"access"|"preview"|"download",recheck:()=>Promise<Viewer>) {
  const p=new URL(request.url).searchParams,caseId=str(p.get("case"),"case",80),docId=str(p.get("document"),"document",80),versionId=str(p.get("version"),"version",80,false);
  const download=mode==="download";
  const {item,version}=await scoped(db,viewer,tx=>documentVersion(tx,viewer,caseId,docId,versionId,download));
  if(mode==="access")return json({ok:true});
  await throttle(db,`client-document-${mode}:${viewer.kind}:${viewer.id}`,download?20:100,300_000);
  const fetchBytes=(tx:Db)=>readClientObject(tx,item.org_id,item.customer_id,version.storage_key,version.storage_backend,version.byte_size,version.sha256);
  const bytes=await (version.storage_backend==="preview-db"?scoped(db,viewer,fetchBytes):fetchBytes(db));
  const sessionRef=createHash("sha256").update(viewer.session).digest("hex").slice(0,8);
  const subject=viewer.kind==="client"?`Client …${viewer.id.slice(-6)}`:`Staff ${viewer.actor.employee_no||"…"+viewer.id.slice(-6)}`;
  const watermark=["CONFIDENTIAL — WALSHKEN IMMIGRATION",`${subject} · Session ${sessionRef} · ${now().slice(0,16).replace("T"," ")} UTC`] as const;
  const page=download?null:integer(p.get("page")??"1","page",1,version.page_count);
  const content=page===null?bytes:await renderDocumentPage(version.filename,bytes,page,watermark);
  const fresh=await recheck();
  if(fresh.id!==viewer.id||fresh.session!==viewer.session)return fail(401,"This session is no longer active.");
  await scoped(db,fresh,async tx=>{
    await documentVersion(tx,fresh,caseId,docId,version.id,download);
    await event(tx,fresh,item,download?"Downloaded original":"Previewed",page?String(page):"",version.id);
  });
  return new Response(Uint8Array.from(content),{headers:{
    "Content-Type":download?version.mime:"image/jpeg",
    "Content-Disposition":download?`attachment; filename="walshken-original.${version.mime==="application/pdf"?"pdf":version.mime==="image/jpeg"?"jpg":"png"}"`:"inline",
    "Cache-Control":"private, no-store, max-age=0","X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin",
    "Content-Security-Policy":"default-src 'none'; sandbox","Referrer-Policy":"no-referrer",
  }});
}

async function checkDisposal(db:Db,item:Document) {
  await assertClientCaseUnheld(db,item.case_id,item.customer_id);
  if(await one(db,"SELECT id FROM client_document_holds WHERE document_id=? AND released_at IS NULL",item.id))return fail(409,"An active legal hold protects this document.");
  if(!await policy(db,item.org_id))return fail(409,"Record a reviewed document retention policy before authorizing disposal.");
  if(await one(db,"SELECT id FROM client_document_versions WHERE document_id=? AND retain_until>? LIMIT 1",item.id,now())) return fail(409,"A version is still within its retained period.");
}

async function finishDisposal(db:Db,disposal:Disposal,staff:Viewer) {
  return db.transaction(async tx=>{
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",disposal.org_id);
    await one(tx,"SELECT id FROM client_cases WHERE id=? AND org_id=? FOR UPDATE",disposal.case_id,disposal.org_id);
    const item=await one<Document>(tx,"SELECT * FROM client_documents WHERE id=? AND org_id=? FOR UPDATE",disposal.document_id,disposal.org_id);
    if(!item||item.deleted_at)return false;
    if(!await one(tx,"SELECT id FROM client_document_disposals WHERE id=? AND status='Approved'",disposal.id))return false;
    await checkDisposal(tx,item);
    const versions=await all<Version>(tx,"SELECT storage_key,storage_backend FROM client_document_versions WHERE document_id=?",item.id);
    for(const version of versions)await removeClientObject(tx,item.org_id,item.customer_id,version.storage_key,version.storage_backend);
    const at=now();
    await run(tx,"UPDATE client_documents SET deleted_at=?,updated_at=? WHERE id=?",at,at,item.id);
    await run(tx,"UPDATE client_document_disposals SET status='Disposed',disposed_at=? WHERE id=?",at,disposal.id);
    await event(tx,staff,item,"Originals disposed","All retained versions removed from private storage");
    await notifyClient(tx,item.customer_id,notice("Document disposal completed","Walshken completed an authorized document disposal.",`disposed:${disposal.id}`));
    return true;
  });
}

export async function clientDocumentAction(db:Db,viewer:Viewer,action:string,data:Record<string,unknown>) {
  const caseId=str(data.case,"case",80);
  if(action==="policy"){
    if(viewer.kind!=="staff"||viewer.actor.role!=="super_admin")return fail(403,"Super Admin access is required.");
    const row=await accountScope(db,viewer,caseId);
    return db.transaction(async tx=>{
      await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",row.org_id);
      const configuration=await policy(tx,row.org_id);
      const revision=integer(data.revision??0,"policy revision",0,1_000_000);
      if((configuration?.revision??0)!==revision)return fail(409,"Reload the latest document policy before saving.");
      const days=integer(data.retention,"reviewed retention days",1,36500),basis=str(data.basis,"reviewed legal or contractual basis",1500);
      await run(tx,"INSERT INTO client_document_policies(org_id,revision,retain_days,client_download,policy_basis,reviewed_by,created_at) VALUES(?,?,?,?,?,?,?)",row.org_id,revision+1,days,data.download===true,basis,viewer.id,now());
      await audit(tx,viewer.actor,"Client document retention and access policy saved","client document policy").run();
      return json({ok:true,message:"Policy saved. Existing retention dates remain protected."});
    });
  }
  const target=str(data.document,"document",80);
  const result=await db.transaction(async tx=>{
    if(action==="decide-deletion"&&administrator(viewer)&&viewer.kind==="staff")await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",viewer.actor.org_id);
    const row=await accountScope(tx,viewer,caseId,true),item=await document(tx,row,target);
    if(item.deleted_at)return fail(404,"The document is unavailable.");
    if(action==="request-deletion"){
      if(viewer.kind!=="client"&&!administrator(viewer))return fail(403,"An authorized administrator must request staff disposal.");
      const reason=str(data.reason,"reason for the request",1200),record=id();
      await run(tx,`INSERT INTO client_document_disposals(id,org_id,case_id,customer_id,document_id,requested_by_staff,requested_at,request_reason)
        VALUES(?,?,?,?,?,?,?,?)`,record,item.org_id,item.case_id,item.customer_id,item.id,viewer.kind==="staff"?viewer.id:null,now(),reason);
      await event(tx,viewer,item,"Deletion requested",reason);
      await notifyCaseStaff(tx,row,"Document deletion request","A client document deletion request is awaiting review.",record);
      return {message:"Deletion request submitted for review."};
    }
    if(viewer.kind!=="staff")return fail(403,"This document action is limited to authorized staff.");
    if(action==="review"){
      if(await one(tx,"SELECT id FROM client_document_disposals WHERE document_id=? AND status='Approved'",item.id))return fail(409,"This document was approved for disposal.");
      const decision=pick(data.decision,["Accepted","Replacement requested"],"review decision"),reason=str(data.reason,"client-facing review note",1000,decision==="Replacement requested");
      const latest=await one<{id:string}>(tx,"SELECT id FROM client_document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1",item.id);
      if(!latest||latest.id!==data.version)return fail(409,"This document has a newer version. Reload it before reviewing.");
      await run(tx,"UPDATE client_documents SET review_status=?,updated_at=? WHERE id=?",decision,now(),item.id);
      if(item.request_id)await run(tx,`UPDATE client_case_document_requests q SET updated_at=?,status=CASE WHEN ?='Replacement requested' THEN 'Replacement requested'
        WHEN EXISTS(SELECT 1 FROM client_documents d WHERE d.request_id=q.id AND d.deleted_at IS NULL AND d.review_status<>'Accepted') THEN 'Submitted' ELSE 'Accepted' END
        WHERE q.id=? AND q.case_id=? AND q.org_id=? AND q.status<>'Cancelled'`,now(),decision,item.request_id,row.id,row.org_id);
      await event(tx,viewer,item,"Reviewed",decision+(reason?`: ${reason}`:""),latest.id);
      await notifyClient(tx,item.customer_id,notice(decision==="Accepted"?"Document accepted":"Replacement requested",
        reason||`A document for case ${row.reference} was accepted.`,`review:${latest.id}:${decision}`));
      return {message:decision==="Accepted"?"Document accepted.":"The client has been asked to submit a replacement."};
    }
    if(!administrator(viewer))return fail(403,"An authorized administrator must manage legal holds or disposal.");
    if(action==="hold"){
      const reason=str(data.reason,"legal hold authority",1200);
      await run(tx,"INSERT INTO client_document_holds(id,org_id,case_id,customer_id,document_id,placed_by,reason,placed_at) VALUES(?,?,?,?,?,?,?,?)",id(),item.org_id,item.case_id,item.customer_id,item.id,viewer.id,reason,now());
      await event(tx,viewer,item,"Hold placed",reason);
      return {message:"Legal hold recorded."};
    }
    if(action==="release-hold"){
      const hold=await one<{id:string;placed_by:string}>(tx,"SELECT id,placed_by FROM client_document_holds WHERE document_id=? AND released_at IS NULL",item.id);
      if(!hold)return fail(404,"An active legal hold was not found.");
      if(hold.placed_by===viewer.id)return fail(403,"A different administrator must approve releasing this legal hold.");
      const reason=str(data.reason,"release authority",1200);
      await run(tx,"UPDATE client_document_holds SET released_by=?,release_reason=?,released_at=? WHERE id=?",viewer.id,reason,now(),hold.id);
      await event(tx,viewer,item,"Hold released",reason);
      return {message:"Legal hold released."};
    }
    if(action!=="decide-deletion")return fail(404,"The document action is unavailable.");
    const disposal=await one<Disposal>(tx,"SELECT * FROM client_document_disposals WHERE id=? AND document_id=? AND org_id=? AND status='Requested'",str(data.disposal,"deletion request",80),item.id,item.org_id);
    if(!disposal)return fail(404,"The pending deletion request is unavailable.");
    if(disposal.requested_by_staff===viewer.id)return fail(403,"A different administrator must decide a staff disposal request.");
    const decision=pick(data.decision,["Approved","Declined"],"deletion decision"),reason=str(data.reason,"review decision reasoning",1200);
    if(decision==="Approved")await checkDisposal(tx,item);
    await run(tx,"UPDATE client_document_disposals SET status=?,reviewed_by=?,reviewed_at=?,review_reason=? WHERE id=?",decision,viewer.id,now(),reason,disposal.id);
    await event(tx,viewer,item,decision==="Approved"?"Deletion approved":"Deletion declined",reason);
    if(decision==="Declined")await notifyClient(tx,item.customer_id,notice("Document deletion decision","Walshken reviewed your request. Contact the company through your case for the decision details.",`deletion:${disposal.id}`));
    return {message:decision==="Approved"?"Disposal approved.":"Deletion request declined.",disposal:decision==="Approved"?disposal:null};
  });
  if(result.disposal&&viewer.kind==="staff"){
    try{await finishDisposal(db,result.disposal,viewer);}
    catch{return json({ok:true,message:"Disposal approved and queued. It will retry while permitted."});}
  }
  return json({ok:true,message:result.message});
}

export async function maintainClientDocuments(db:Db,org:string) {
  const staged=await cleanupPendingClientObjects(db,org),jobs=await all<Disposal&{reviewed_by:string}>(db,"SELECT * FROM client_document_disposals WHERE org_id=? AND status='Approved' ORDER BY reviewed_at LIMIT 10",org);
  let disposed=0;
  for(const job of jobs){
    const saved=await one<Actor>(db,"SELECT * FROM employees WHERE id=? AND org_id=?",job.reviewed_by,org);
    if(!saved)continue;
    try{if(await finishDisposal(db,job,{kind:"staff",id:saved.id,actor:saved,session:"maintenance"}))disposed++;}
    catch{/* Preserve the reviewed authorization and keep failed physical removals retryable. */}
  }
  return {staged,disposed};
}
