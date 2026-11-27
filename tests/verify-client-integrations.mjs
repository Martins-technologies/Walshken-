import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {clientDocumentBackend,readClientObject,validateClientStorage} from "../lib/walshken/client-document-storage.ts";
import {validateLiveKit} from "../lib/walshken/livekit.ts";

const keys=["VERCEL_ENV","WALSHKEN_CLIENT_PORTAL_ENABLED","WALSHKEN_CLIENT_PREVIEW_LIVEKIT_URL","WALSHKEN_CLIENT_PREVIEW_STORAGE_BUCKET",
  "WALSHKEN_CLIENT_PREVIEW_DB_OBJECTS","WALSHKEN_STORAGE_ALLOWED_HOSTS","WALSHKEN_SERVER_INTEGRATIONS","WALSHKEN_DOCUMENT_STORAGE_ID"];
const saved=new Map(keys.map(key=>[key,process.env[key]]));
const originalFetch=globalThis.fetch;
const recording={endpoint:"https://s3.us-west-2.amazonaws.com",region:"us-west-2",bucket:"walshken-private-staff-test",accessKey:"QA-FIXTURE",secretKey:"local-validation-fixture"};
const calls={url:"wss://walshken-isolated-test.livekit.cloud",apiKey:"QA-call-fixture",apiSecret:"local-validation-fixture"};
const bytes=Buffer.from("Synthetic confidential document body");
const hash=createHash("sha256").update(bytes).digest("hex");
const key="walshken-client/test-case/test-document/test-version";
const connection=(clientStorageDisabled=false)=>({prepare(sql,args){return {async first(){
  if(sql.includes("configuration,enabled"))return clientStorageDisabled&&args[0]==="client-document-storage"?{enabled:0,configuration:"unused"}:null;
  if(sql.includes("WHERE id='client-document-storage'"))return clientStorageDisabled?{id:"client-document-storage"}:null;
  throw new Error("Unanticipated integration test query");
}};}});

try{
  process.env.VERCEL_ENV="production";
  process.env.WALSHKEN_CLIENT_PORTAL_ENABLED="1";
  process.env.WALSHKEN_SERVER_INTEGRATIONS=JSON.stringify({"document-storage-review":recording});
  process.env.WALSHKEN_DOCUMENT_STORAGE_ID="document-storage-review";
  process.env.WALSHKEN_CLIENT_PREVIEW_DB_OBJECTS="1";
  assert.equal(validateLiveKit(calls).url,calls.url);
  assert.equal(await clientDocumentBackend(connection()),"s3");
  let requests=0;
  globalThis.fetch=async (raw,options)=>{
    requests++;
    const url=new URL(raw);
    assert.equal(url.origin,recording.endpoint);
    assert.equal(url.pathname,`/${recording.bucket}/${key}`);
    assert.equal(url.searchParams.get("X-Amz-Expires"),"60");
    assert.ok(url.searchParams.get("X-Amz-Signature"));
    assert.equal(options.redirect,"error");
    assert.equal(options.cache,"no-store");
    return new Response(bytes,{headers:{"Content-Length":String(bytes.length)}});
  };
  assert.deepEqual(await readClientObject(connection(),"walshken","test-client",key,"s3",bytes.length,hash),bytes);
  await assert.rejects(()=>readClientObject(connection(),"walshken","test-client",key,"s3",bytes.length,"0".repeat(64)),/integrity check/);
  const expectedRequests=requests;
  await assert.rejects(()=>readClientObject(connection(true),"walshken","test-client",key,"s3",bytes.length,hash),/storage is unavailable/);
  await assert.rejects(()=>readClientObject(connection(),"walshken","test-client","walshken/private-staff-file","s3",bytes.length,hash),/file is unavailable/);
  assert.equal(requests,expectedRequests);

  process.env.VERCEL_ENV="preview";
  assert.equal(await clientDocumentBackend(connection()),"preview-db");
  delete process.env.WALSHKEN_CLIENT_PREVIEW_LIVEKIT_URL;
  assert.throws(()=>validateLiveKit(calls),/dedicated Preview LiveKit/);
  process.env.WALSHKEN_CLIENT_PREVIEW_LIVEKIT_URL=calls.url;
  assert.equal(validateLiveKit(calls).url,calls.url);
  assert.throws(()=>validateLiveKit({...calls,url:"wss://another-project-test.livekit.cloud"}),/dedicated Preview LiveKit/);
  await assert.rejects(()=>readClientObject(connection(),"walshken","test-client",key,"s3",bytes.length,hash),/storage is unavailable/);
  assert.equal(requests,expectedRequests,"Preview never falls back to shared production document settings");
  process.env.WALSHKEN_CLIENT_PREVIEW_STORAGE_BUCKET="walshken-client-preview-test";
  assert.throws(()=>validateClientStorage(recording),/dedicated Preview bucket/);
  const preview={...recording,bucket:process.env.WALSHKEN_CLIENT_PREVIEW_STORAGE_BUCKET};
  assert.throws(()=>validateClientStorage({...preview,endpoint:"https://ssggjxyexwkshtcypsaq.storage.supabase.co/storage/v1/s3"}),/isolated from production/);
  assert.equal(validateClientStorage(preview).bucket,preview.bucket);
  process.env.WALSHKEN_SERVER_INTEGRATIONS=JSON.stringify({"document-storage-review":recording,"client-document-storage":preview});
  assert.equal(await clientDocumentBackend(connection()),"s3","Selecting private S3 requires no change to the fallback flag");
  const host="abcdefghijklmnopqrst.storage.supabase.co";
  assert.throws(()=>validateClientStorage({...preview,endpoint:`https://${host}/storage/v1/s3`}),/Supabase project's S3 endpoint/);
  process.env.WALSHKEN_STORAGE_ALLOWED_HOSTS=host;
  assert.equal(validateClientStorage({...preview,endpoint:`https://${host}/storage/v1/s3`}).endpoint,`https://${host}/storage/v1/s3`);
  assert.throws(()=>validateClientStorage({...preview,endpoint:`https://${host}/storage/v1/s3?unexpected=1`}),/S3 endpoint/);
}finally{
  globalThis.fetch=originalFetch;
  for(const [name,value] of saved)if(value===undefined)delete process.env[name];else process.env[name]=value;
}
console.log("PASS production storage reuse, restricted signed reads, integrity checks, and isolated Preview storage and LiveKit pins");
