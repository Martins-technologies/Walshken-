import type { ReactNode } from "react";
import type { ClientSection } from "@/lib/walshken/client-feature";
import { Icon } from "./brand";

export type ClientCase = {
  id:string; reference:string; title:string; service:string; country:string; client_status:string; representative_name:string|null;
  representative_designation:string|null; communication_enabled:boolean; created_at:string; submitted_at:string|null; application_submitted_on:string|null;
};
export const dateLabel=(input:string|null|undefined)=>input
  ?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",...(input.includes("T")?{timeStyle:"short"}:{timeZone:"UTC"})}).format(new Date(input))
  :"";
export const caseLink=(section:ClientSection,caseId?:string)=>"/customer"+(section==="overview"?"":"/"+section)+(caseId?"?case="+encodeURIComponent(caseId):"");
export function ClientEmpty({icon,title,children}:{icon:string;title:string;children?:ReactNode}){
  return <div className="client-empty"><span className="client-symbol"><Icon name={icon}/></span><strong>{title}</strong>{children}</div>;
}
