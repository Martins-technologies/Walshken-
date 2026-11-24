import {employmentEngineEnabled} from "./employment-catalog";
import { all, audit, fail, id, json, now, one, pick, requireSuper, run, str, type Actor, type Db } from "./server";
import { validDay } from "./holiday-access";

import { employmentCountries } from "./jurisdiction-catalog";

export function verifiedStaffLocation(country: string, jurisdiction: string) {
  if (!(country in employmentCountries) || !new RegExp(`^${country}-[A-Z0-9]{2,8}$`).test(jurisdiction)) {
    return fail(400,"Choose Canada, India or Pakistan and use a matching province, state or federal employment jurisdiction code.");
  }
}

export function jurisdictionVersions(db: Db, actor: Actor) {
  requireSuper(actor);
  return all(db,`SELECT v.*, COALESCE(d.decision,'Draft') AS status, d.reason AS decision_reason,
    author.name AS author, verifier.name AS verifier
    FROM staff_jurisdiction_versions v JOIN employees author ON author.id=v.created_by
    LEFT JOIN LATERAL (SELECT decision,reason,actor_id FROM staff_jurisdiction_decisions
      WHERE version_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1) d ON true
    LEFT JOIN employees verifier ON verifier.id=d.actor_id
    WHERE v.org_id=? ORDER BY v.jurisdiction,v.effective_from DESC,v.created_at DESC LIMIT 300`,actor.org_id);
}

export async function jurisdictionAction(db: Db, actor: Actor, action: string, data: Record<string, unknown>) {
  requireSuper(actor);
  return db.transaction(async tx => {
    await one(tx,"SELECT id FROM organizations WHERE id=? FOR UPDATE",actor.org_id);
    if (action === "jurisdiction-save") {
      const country = pick(data.country,["CA","IN","PK"] as const,"employment country");
      const jurisdiction = str(data.jurisdiction,"jurisdiction code",12).toUpperCase();
      verifiedStaffLocation(country,jurisdiction);
      const classification = str(data.classification,"employee coverage or establishment classification",120);
      const version = str(data.version,"version",80);
      const start = validDay(data.effectiveFrom,"first effective date");
      const end = validDay(data.effectiveThrough,"last effective date");
      const source = str(data.source,"official source URL",1500);
      let url:URL;
      try { url=new URL(source); }
      catch { return fail(400,"Enter a valid HTTPS source URL."); }
      if (start>end || url.protocol!=="https:" || url.username || url.password || url.port) return fail(400,"Enter ordered effective dates and an HTTPS statutory source.");
      if (await one(tx,"SELECT id FROM staff_jurisdiction_versions WHERE org_id=? AND jurisdiction=? AND classification=? AND version=?",actor.org_id,jurisdiction,classification,version)) return fail(409,"That version already exists. Enter a new version for changes.");
      const target=id();
      await run(tx,`INSERT INTO staff_jurisdiction_versions(id,org_id,country,jurisdiction,classification,version,effective_from,effective_through,source_url,evidence,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,target,actor.org_id,country,jurisdiction,classification,version,start,end,url.href,str(data.evidence,"applicability, rules and evidence",12_000),actor.id,now());
      await audit(tx,actor,"Jurisdiction review version saved","jurisdiction",target).run();
      return json({ok:true,message:"Draft jurisdiction evidence saved."},201);
    }
    const target=str(data.id,"jurisdiction version",80);
    const row=await one<{created_by:string;status:string;category?:string;mandatory?:boolean;effective_from?:string}>(tx,`SELECT v.*,COALESCE((SELECT decision FROM staff_jurisdiction_decisions
      WHERE version_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1),'Draft') AS status
      FROM staff_jurisdiction_versions v WHERE v.id=? AND v.org_id=?`,target,actor.org_id);
    if (!row) return fail(404,"Jurisdiction version unavailable.");
    const verify=action === "jurisdiction-verify";
    if(employmentEngineEnabled()&&row.category!=="Evidence"){
      if(!verify&&row.mandatory&&row.status==="Verified")return fail(409,"A verified statutory policy must be superseded by a legally reviewed version. It cannot be withdrawn.");
      if(verify){
        const policy=await one<{jurisdiction:string;category:string;classification:string;effective_from:string;effective_through:string;predecessor_id:string|null}>(tx,"SELECT * FROM staff_jurisdiction_versions WHERE id=?",target);
        const overlap=await one(tx,`WITH RECURSIVE ancestors AS (
          SELECT id,predecessor_id FROM staff_jurisdiction_versions WHERE id=? AND org_id=?
          UNION ALL SELECT v.id,v.predecessor_id FROM staff_jurisdiction_versions v JOIN ancestors a ON v.id=a.predecessor_id WHERE v.org_id=?
        ) SELECT v.id FROM staff_jurisdiction_versions v WHERE v.org_id=? AND v.jurisdiction=? AND v.category=? AND v.classification=?
          AND v.id<>? AND v.effective_from<=? AND v.effective_through>=?
          AND (SELECT decision FROM staff_jurisdiction_decisions WHERE version_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1)='Verified'
          AND v.id NOT IN(SELECT id FROM ancestors) LIMIT 1`,policy!.predecessor_id,actor.org_id,actor.org_id,actor.org_id,policy!.jurisdiction,policy!.category,policy!.classification,target,policy!.effective_through,policy!.effective_from);
        if(overlap)return fail(409,"Overlapping approved policy versions require ordered effective dates and an explicit predecessor.");
      }
    }
    if (verify && row.created_by===actor.id) return fail(403,"A separate Super Admin must verify the evidence.");
    if (verify ? row.status!=="Draft" : row.status==="Withdrawn") return fail(409,"The version already has a decision.");
    await run(tx,"INSERT INTO staff_jurisdiction_decisions(id,version_id,decision,reason,actor_id,created_at) VALUES(?,?,?,?,?,?)",id(),target,verify?"Verified":"Withdrawn",str(data.reason,"decision evidence",2000),actor.id,now());
    await audit(tx,actor,verify?"Jurisdiction evidence verified":"Jurisdiction evidence withdrawn","jurisdiction",target).run();
    return json({ok:true,message:verify?"Evidence verified and recorded. Payroll requires a supported calculation engine.":"Version withdrawn. Prior decisions remain in the audit history."});
  });
}
