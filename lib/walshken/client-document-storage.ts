import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { integrationSettings } from "./integration-settings";
import { storageClient, validateStorage, type RecordingStorage } from "./livekit";
import { fail, one, run, now, type Db } from "./server";
import { clientDocumentMaxSize } from "./client-document-types";

export type ClientStorageBackend = "s3" | "preview-db";
export const clientPreviewDocumentObjects = () => process.env.WALSHKEN_CLIENT_PREVIEW_DB_OBJECTS === "1"
  && (process.env.VERCEL_ENV === "preview" || process.env.NODE_ENV === "test");

export const clientDocumentBackend = (): ClientStorageBackend => clientPreviewDocumentObjects() ? "preview-db" : "s3";

async function clientStorage(db:Db) {
  const settings = await integrationSettings(db, "client-document-storage");
  if (!settings) return fail(503, "Client file storage is unavailable. Contact Walshken about a secure upload.");
  const valid = validateStorage(settings as RecordingStorage);
  if (valid.bucket === "walshken-call-recordings") return fail(503, "Client files require a separate private bucket.");
  return valid;
}

function requirePreviewStorage() {
  if (!clientPreviewDocumentObjects()) return fail(503, "Preview document storage is unavailable in this environment.");
}

export async function storeClientObject(db:Db, org:string, customer:string, key:string, backend:ClientStorageBackend, bytes:Buffer, mime:string) {
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
  let bytes:Buffer;
  if (backend === "preview-db") {
    requirePreviewStorage();
    const row=await one<{body:Buffer|Uint8Array}>(db,"SELECT body FROM client_preview_document_objects WHERE storage_key=? AND org_id=? AND customer_id=?",key,org,customer);
    if (!row) return fail(404,"The stored file is unavailable.");
    bytes=Buffer.from(row.body);
  } else {
    const settings=await clientStorage(db),client=storageClient(settings);
    try {
      const response=await client.send(new GetObjectCommand({Bucket:settings.bucket,Key:key}));
      if (!response.Body||response.ContentLength!==expectedSize||expectedSize>clientDocumentMaxSize) return fail(409,"The stored file failed an integrity check.");
      bytes=Buffer.from(await response.Body.transformToByteArray());
    } finally {client.destroy();}
  }
  if (bytes.length!==expectedSize||createHash("sha256").update(bytes).digest("hex")!==expectedSha) return fail(409,"The stored file failed an integrity check.");
  return bytes;
}

export async function removeClientObject(db:Db, org:string, customer:string, key:string, backend:ClientStorageBackend) {
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
