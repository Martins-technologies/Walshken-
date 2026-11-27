import { createCanvas } from "@napi-rs/canvas";
import { clientDocumentCategories, clientWatermarkDefault, clientWatermarkPositions, type ClientWatermarkPolicy } from "./client-document-types";
import { applyDocumentWatermark, type DocumentWatermarkOverlay } from "./document-render";
import { fail, integer, now, one, pick, str, type Db } from "./server";

export async function clientWatermarkPolicy(db: Db, org: string) {
  return await one<ClientWatermarkPolicy>(db,`SELECT revision,enabled,label,opacity,position,repeat_mark,show_client,show_time,categories
    FROM client_document_watermark_settings WHERE org_id=? ORDER BY revision DESC LIMIT 1`,org)??clientWatermarkDefault;
}

export function parseClientWatermark(data: Record<string,unknown>): Omit<ClientWatermarkPolicy,"revision"> {
  const categories = data.categories;
  if (!Array.isArray(categories) || categories.length>clientDocumentCategories.length) return fail(400,"Choose supported categories for the watermark.");
  for (const field of ["enabled","repeat_mark","show_client","show_time"]) if (typeof data[field]!=="boolean") return fail(400,"Choose a value for each watermark option.");
  const chosen = [...new Set(categories.map(value=>pick(value,clientDocumentCategories,"watermark category")))];
  if (data.enabled && !chosen.length) return fail(400,"Choose at least one sensitive category before enabling the watermark.");
  const label=str(data.label,"watermark text",110);
  if (/[\p{Cc}\p{Cf}]/u.test(label)) return fail(400,"Use printable characters in your watermark text.");
  return {
    label,enabled:data.enabled===true,opacity:integer(data.opacity,"watermark opacity",5,80),
    position:pick(data.position,clientWatermarkPositions,"watermark position"),repeat_mark:data.repeat_mark===true,
    show_client:data.show_client===true,show_time:data.show_time===true,categories:chosen,
  };
}

export function clientWatermarkOverlay(policy:Omit<ClientWatermarkPolicy,"revision">,clientId:string,stamp=now()): DocumentWatermarkOverlay|null {
  if (!policy.enabled) return null;
  const details=[policy.show_client?"Client …"+clientId.slice(-6):"",policy.show_time?stamp.slice(0,16).replace("T"," ")+" UTC":""].filter(Boolean);
  return {label:policy.label,detail:details.join(" · "),alpha:policy.opacity/100,position:policy.position,repeat:policy.repeat_mark};
}

export function clientWatermarkSample(policy:Omit<ClientWatermarkPolicy,"revision">) {
  const canvas=createCanvas(620,430),ctx=canvas.getContext("2d");
  ctx.fillStyle="#fff";
  ctx.fillRect(0,0,620,430);
  ctx.fillStyle="#20324b";
  ctx.font="bold 28px Walshken, sans-serif";
  ctx.fillText("Walshken document preview",42,77);
  ctx.font="15px Walshken, sans-serif";
  ctx.fillText("Sample document for reviewing watermark placement",42,112);
  ctx.fillStyle="#e4e9f1";
  for(let line=0;line<8;line++) ctx.fillRect(42,150+line*28,line%3===2?330:518,8);
  const overlay=clientWatermarkOverlay(policy,"SAMPLE001412");
  if(overlay) applyDocumentWatermark(canvas,overlay);
  return new Response(Uint8Array.from(canvas.toBuffer("image/jpeg",86)),{headers:{
    "Content-Type":"image/jpeg","Cache-Control":"private, no-store, max-age=0","Cross-Origin-Resource-Policy":"same-origin",
    "X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox",
  }});
}
