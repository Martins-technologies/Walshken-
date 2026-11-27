import {all,audit,country,date,decryptSettings,encryptSettings,fail,id,integer,json,now,one,run,str,type Actor,type Db} from "./server";
import type {Customer} from "./customer";

const emptyDetails = {
  dob:"", phone:"", address:"", countryOfBirth:"", countryOfResidence:"", citizenships:[] as string[], passportNumber:"",
  passportCountry:"", immigrationHistory:"", immigrationStatus:"", language:"", emergencyName:"", emergencyPhone:"",
};
type ProfileDetails = typeof emptyDetails;
type Profile = ProfileDetails & {name: string; email: string};
type Stored = {encrypted_details:string; verified_fields:string[]; revision:number; updated_at:string};
const requiredFields = ["name","dob","phone","address","countryOfBirth","countryOfResidence","citizenships","language"] as const;
const editableFields = ["name", ...Object.keys(emptyDetails)] as (keyof Omit<Profile,"email">)[];
const context = (customerId:string) => `client-profile:${customerId}`;

async function loadProfile(db:Db, actor:Customer, lock = false) {
  const record = await one<Stored>(db,`SELECT * FROM client_profiles WHERE customer_id=? ${lock?"FOR UPDATE":""}`,actor.id);
  const saved = record ? JSON.parse((await decryptSettings(context(actor.id),record.encrypted_details)).details) as Partial<ProfileDetails> : {};
  return {record,details:{...emptyDetails,...saved}};
}

export async function clientProfileSnapshot(db:Db, actor:Customer) {
  const {record,details} = await loadProfile(db,actor);
  const profile = {...details,name:actor.name,email:actor.email};
  const history = await all(db,`SELECT id,actor,action,fields,created_at AS "createdAt" FROM client_profile_history
    WHERE customer_id=? ORDER BY created_at DESC,id DESC LIMIT 50`,actor.id);
  const complete = requiredFields.filter(field=>profile[field].length>0).length;
  return {profile,version:record?.revision??0,verifiedFields:["email",...(record?.verified_fields??[])],requiredFields,completion:Math.round(100*complete/requiredFields.length),history};
}

export async function customerProfileData(db:Db,actor:Customer) {
  return json(await clientProfileSnapshot(db,actor));
}

export async function recordClientProfileChange(db:Db, actorId:string, who:"Client"|"Company", action:"Profile updated"|"Verified fields updated"|"Email changed", fields:string[], changes?: unknown) {
  const target = id();
  const encrypted = changes===undefined ? null : await encryptSettings(`client-profile-change:${target}`,{details:JSON.stringify(changes)});
  await run(db,`INSERT INTO client_profile_history(id,customer_id,actor,action,fields,encrypted_change,created_at)
    VALUES (?,?,?,?,?::text[],?,?)`, target,actorId,who,action,fields,encrypted,now());
}

function parsePhone(input:unknown,label:string) {
  const value = str(input,label,30,false);
  if (value && (!/^\+?[0-9() .-]+$/.test(value) || value.replace(/\D/g,"").length<7 || value.replace(/\D/g,"").length>15)) {
    return fail(400,`Enter a valid ${label}, including the country code when appropriate.`);
  }
  return value;
}
function parseCountry(input:unknown) {
  return input ? country(input) : "";
}
function parseCitizenships(input:unknown) {
  const values = typeof input==="string" ? input.split(",").map(value=>value.trim()).filter(Boolean) : input;
  if (!Array.isArray(values) || values.length>8) return fail(400,"Choose up to eight citizenships.");
  return [...new Set(values.map(country))];
}
function parseBirthDate(input:unknown) {
  const birth = date(input,"date of birth",false) ?? "";
  if (birth && (birth<"1900-01-01" || birth>now().slice(0,10))) return fail(400,"Enter a date of birth in the past.");
  return birth;
}
function parsePassport(input:unknown) {
  const number = str(input,"passport number",30,false).toUpperCase();
  if (number && !/^[A-Z0-9][A-Z0-9 .-]+$/.test(number)) return fail(400,"Enter a valid passport number.");
  return number;
}

const detailsFields = {
  dob:parseBirthDate, phone:(input:unknown)=>parsePhone(input,"phone number"),
  address:(input:unknown)=>str(input,"residential address",600,false),
  countryOfBirth:parseCountry, countryOfResidence:parseCountry, citizenships:parseCitizenships,
  passportNumber:parsePassport, passportCountry:parseCountry,
  immigrationHistory:(input:unknown)=>str(input,"immigration history",2000,false),
  immigrationStatus:(input:unknown)=>str(input,"current immigration status",160,false),
  language:(input:unknown)=>str(input,"preferred language",60,false),
  emergencyName:(input:unknown)=>str(input,"emergency contact name",100,false),
  emergencyPhone:(input:unknown)=>parsePhone(input,"emergency contact number"),
};

export async function updateCustomerProfile(db:Db,actor:Customer,input:Record<string,unknown>) {
  return db.transaction(async tx=>{
    const customer = await one<{name:string;email:string;email_verified_at:string|null;suspended_at:string|null}>(tx,
      "SELECT name,email,email_verified_at,suspended_at FROM customers WHERE id=? FOR UPDATE",actor.id);
    if (!customer?.email_verified_at || customer.suspended_at) return fail(403,"Verify your account before editing the profile.");
    if (input.email!==undefined && input.email!==customer.email) return fail(409,"Use Security to verify a new email address.");
    const {record,details} = await loadProfile(tx,actor,true);
    if (integer(input.version,"profile version",0,2147483647)!==(record?.revision??0)) return fail(409,"This profile changed. Refresh before saving.");
    const patch = Object.fromEntries(Object.entries(detailsFields).filter(([key])=>key in input).map(([key,parser])=>[key,parser(input[key])]));
    const current = {...details,name:customer.name};
    const name = input.name===undefined ? current.name : str(input.name,"full legal name",100);
    const updated = {...details,...patch,name};
    const changed = editableFields.filter(field=>JSON.stringify(current[field])!==JSON.stringify(updated[field]));
    if (changed.some(field=>record?.verified_fields.includes(field))) return fail(403,"Company-verified fields require an authorized correction. Contact your representative.");
    if (!changed.length) return json({ok:true,message:"No profile changes to save.",version:record?.revision??0});
    if (!!updated.passportNumber !== !!updated.passportCountry) return fail(400,"Enter both the passport number and issuing country, or leave both blank.");
    if (!!updated.emergencyName !== !!updated.emergencyPhone) return fail(400,"Enter both the emergency contact’s name and phone number, or leave both blank.");
    const newDetails = {...details,...patch};
    const encrypted = await encryptSettings(context(actor.id),{details:JSON.stringify(newDetails)});
    const stamp = now();
    await run(tx,`INSERT INTO client_profiles(customer_id,encrypted_details,updated_at) VALUES (?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET encrypted_details=excluded.encrypted_details,updated_at=excluded.updated_at,revision=client_profiles.revision+1`,actor.id,encrypted,stamp);
    if (name!==current.name) await run(tx,"UPDATE customers SET name=? WHERE id=?",name,actor.id);
    await recordClientProfileChange(tx,actor.id,"Client","Profile updated",changed,{
      previous:Object.fromEntries(changed.map(field=>[field,current[field]])),
      current:Object.fromEntries(changed.map(field=>[field,updated[field]])),
    });
    return json({ok:true,message:"Profile saved.",version:(record?.revision??0)+1});
  });
}

export async function setVerifiedClientFields(db:Db,reviewer:Actor,customerId:string,input:Record<string,unknown>) {
  if (!Array.isArray(input.fields)||input.fields.length>editableFields.length||!input.fields.every(field=>editableFields.includes(field))) {
    return fail(400,"Choose listed profile fields only.");
  }
  const fields = [...new Set(input.fields)] as typeof editableFields;
  return db.transaction(async tx=>{
    const company = await one<Customer>(tx,"SELECT id,name,email FROM customers WHERE id=? AND email_verified_at IS NOT NULL AND suspended_at IS NULL FOR UPDATE",customerId);
    if (!company) return fail(404,"Client profile unavailable.");
    const {record,details} = await loadProfile(tx,company,true);
    const version = integer(input.version,"profile version",0,2147483647);
    if(version!==(record?.revision??0))return fail(409,"This profile changed. Refresh before saving.");
    const existing = {...details,name:company.name};
    if (fields.some(field=>!existing[field].length)) return fail(400,"Only populated profile fields can be verified.");
    const difference = editableFields.filter(field=>fields.includes(field)!==(record?.verified_fields.includes(field)??false));
    if (!difference.length) return json({ok:true,version});
    const encrypted = record?.encrypted_details ?? await encryptSettings(context(customerId),{details:JSON.stringify(details)});
    await run(tx,`INSERT INTO client_profiles(customer_id,encrypted_details,verified_fields,updated_at) VALUES (?,?,?::text[],?)
      ON CONFLICT(customer_id) DO UPDATE SET verified_fields=excluded.verified_fields,updated_at=excluded.updated_at,revision=client_profiles.revision+1`,customerId,encrypted,fields,now());
    await recordClientProfileChange(tx,customerId,"Company","Verified fields updated",difference,
      {previous:record?.verified_fields??[],current:fields,reason:str(input.reason,"verification evidence",500)});
    await audit(tx,reviewer,"Client profile verification updated","client profile",customerId).run();
    return json({ok:true,version:version+1});
  });
}
