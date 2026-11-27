import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { integrationSettings } from "./integration-settings";
import { documentStorage } from "./document-storage";
import { storageClient, validateStorage, type RecordingStorage } from "./livekit";
import { fail, one, run, now, type Db } from "./server";
import { clientDocumentMaxSize } from "./client-document-types";

export type ClientStorageBackend = "s3" | "preview-db";
export const clientPreviewDocumentObjects = () => process.env.WALSHKEN_CLIENT_PREVIEW_DB_OBJECTS === "1"
  && (process.env.VERCEL_ENV === "preview" || (!process.env.VERCEL_ENV&&process.env.NODE_ENV === "test"));

export async function clientDocumentBackend(db:Db):Promise<ClientStorageBackend> {
  if (!clientPreviewDocumentObjects())return "s3";
  const dedicated=await integrationSettings(db,"client-document-storage");
  if (!dedicated)return "preview-db";
  validateClientStorage(dedicated as RecordingStorage);
  return "s3";
}

export function validateClientStorage(settings:RecordingStorage) {
  const valid = validateStorage(settings);
  if (valid.bucket === "walshken-call-recordings") return fail(503, "Client files require a separate private bucket.");
  if (process.env.VERCEL_ENV === "preview") {
    const bucket = process.env.WALSHKEN_CLIENT_PREVIEW_STORAGE_BUCKET?.trim();
    const endpoint = new URL(valid.endpoint).hostname;
    if (!bucket || !/^walshken-client-preview(?:-[a-z0-9-]+)?$/.test(bucket) || valid.bucket !== bucket ||
      endpoint.startsWith("ssggjxyexwkshtcypsaq.")) {
      return fail(409,"Connect the dedicated Preview bucket with credentials isolated from production storage.");
    }
  }
  return valid;
}

async function clientStorage(db:Db) {
  const settings = await integrationSettings(db, "client-document-storage");
  if (settings) return validateClientStorage(settings as RecordingStorage);
  if (process.env.VERCEL_ENV === "preview" || await one(db,"SELECT id FROM integrations WHERE id='client-document-storage'")) {
    return fail(503, "Client file storage is unavailable. Contact Walshken about a secure upload.");
  }
  // The existing staff document integration can serve the dedicated client namespace.
  return validateClientStorage(await documentStorage(db));
}

function requireClientObjectKey(key:string) {
  if (!/^walshken-client(?:\/[a-z0-9_-]{1,80}){3}$/i.test(key)) return fail(404,"The stored file is unavailable.");
}

function requirePreviewStorage() {
  if (!clientPreviewDocumentObjects()) return fail(503, "Preview document storage is unavailable in this environment.");
}

export async function storeClientObject(db:Db, org:string, customer:string, key:string, backend:ClientStorageBackend, bytes:Buffer, mime:string) {
  requireClientObjectKey(key);
  if (backend === "preview-db") {
    requirePreviewStorage();
    await run(db, "INSERT INTO client_preview_document_objects(storage_key,org_id,customer_id,mime,body,created_at) VALUES(?,?,?,?,?,?)",key,org,customer,mime,bytes,now());
    return;
  }
  const settings=await clientStorage(db), client=storageClient(settings);
  try {
    await client.send(new PutObjectCommand({Bucket:settings.bucket,Key:key,Body:bytes,ContentType:mime,CacheControl:"private, no-store",IfNoneMatch:"*"}));
  } finally { client.destroy(); }
}

export async function readClientObject(db:Db, org:string, customer:string, key:string, backend:ClientStorageBackend, expectedSize:number, expectedSha:string) {
  requireClientObjectKey(key);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > clientDocumentMaxSize) return fail(409,"The stored file failed an integrity check.");
  let bytes:Buffer;
  if (backend === "preview-db") {
    requirePreviewStorage();
    const row=await one<{body:Buffer|Uint8Array}>(db,"SELECT body FROM client_preview_document_objects WHERE storage_key=? AND org_id=? AND customer_id=?",key,org,customer);
    if (!row) return fail(404,"The stored file is unavailable.");
    bytes=Buffer.from(row.body);
  } else {
    const settings=await clientStorage(db),client=storageClient(settings);
    let signed:string;
    try {
      signed=await getSignedUrl(client,new GetObjectCommand({Bucket:settings.bucket,Key:key}),{expiresIn:60});
    } finally {client.destroy();}
    // The portal audits and authorizes each request. Never hand upstream credentials or bearer URLs to the browser.
    const response=await fetch(signed,{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12_000)}).catch(()=>null);
    if (!response || response.status!==200 || !response.body) return fail(502,"The private storage provider did not return the requested file.");
    const length=response.headers.get("content-length");
    if (length!==null && Number(length)!==expectedSize) {
      await response.body.cancel().catch(()=>{});
      return fail(409,"The stored file failed an integrity check.");
    }
    const reader=response.body.getReader();
    bytes=Buffer.alloc(expectedSize);
    let offset=0;
    try {
      for (;;) {
        const chunk=await reader.read();
        if (chunk.done) break;
        if (offset+chunk.value.byteLength>expectedSize) return fail(409,"The stored file failed an integrity check.");
        bytes.set(chunk.value,offset);
        offset+=chunk.value.byteLength;
      }
      if(offset!==expectedSize)return fail(409,"The stored file failed an integrity check.");
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  if (bytes.length!==expectedSize||createHash("sha256").update(bytes).digest("hex")!==expectedSha) return fail(409,"The stored file failed an integrity check.");
  return bytes;
}

export async function removeClientObject(db:Db, org:string, customer:string, key:string, backend:ClientStorageBackend) {
  requireClientObjectKey(key);
  if (backend === "preview-db") {
    requirePreviewStorage();
    await run(db,"DELETE FROM client_preview_document_objects WHERE storage_key=? AND org_id=? AND customer_id=?",key,org,customer);
    return;
  }
  const settings=await clientStorage(db),client=storageClient(settings);
  try { await client.send(new DeleteObjectCommand({Bucket:settings.bucket,Key:key})); }
  finally {client.destroy();}
}

export async function cleanupPendingClientObjects(db:Db,org:string) {
  const latest=new Date(Date.now()-60*60_000).toISOString();
  const pending=await db.prepare("SELECT storage_key,storage_backend,customer_id FROM client_upload_pending_objects WHERE org_id=? AND created_at<? ORDER BY created_at LIMIT 15",[org,latest]).all<{storage_key:string;storage_backend:ClientStorageBackend;customer_id:string}>();
  let cleaned=0;
  for (const row of pending.results) {
    try {
      if (!await one(db,"SELECT id FROM client_document_versions WHERE org_id=? AND storage_key=?",org,row.storage_key))
        await removeClientObject(db,org,row.customer_id,row.storage_key,row.storage_backend);
      await run(db,"DELETE FROM client_upload_pending_objects WHERE org_id=? AND storage_key=?",org,row.storage_key);
      cleaned++;
    } catch { /* Pending registry retains evidence for retry. */ }
  }
  return cleaned;
}
