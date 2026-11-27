import {createHash} from "node:crypto";
import {all,fail,id,now,run,str,type Db} from "./server";

export const invoiceCurrencies=["CAD","USD","INR","PKR","GBP","EUR"] as const;
export const electronicConsentVersion="walshken-client-consent-v1";
export const electronicConsent="I have reviewed this exact agreement version. I intend to sign electronically and agree to its terms and undertakings.";
export const digestFinance=(source:string|Uint8Array)=>createHash("sha256").update(source).digest("hex");

export type CaseFinance={id:string;org_id:string;customer_id:string;reference:string};
export type InvoiceItem={position:number;description:string;quantity:number;unit_minor:number;tax_bps:number;subtotal_minor:number;tax_minor:number;total_minor:number};
export type Invoice={
  id:string;org_id:string;case_id:string;customer_id:string;invoice_number:string|null;issuer_name:string;issuer_address:string;
  issuer_tax_number:string;recipient_name:string;recipient_email:string;currency:typeof invoiceCurrencies[number];issue_on:string|null;due_on:string;
  subtotal_minor:number;tax_minor:number;total_minor:number;status:"Draft"|"Open"|"Processing"|"Paid"|"Void";created_at:string;updated_at:string;
  case_reference:string;
};
export type Payment={
  id:string;invoice_id:string;org_id:string;amount_minor:number;currency:Invoice["currency"];sandbox:boolean;status:"Creating"|"Pending"|"Processing"|"Paid"|"Failed"|"Expired";
  invoice_number:string;provider_session:string|null;provider_reference:string|null;receipt_number:string|null;
  checkout_url:string|null;expiry_at:string|null;created_at:string;confirmed_at:string|null;
};
export type AgreementVersion={
  id:string;org_id:string;agreement_id:string;case_id:string;customer_id:string;case_reference:string;version:number;
  title:string;issuer_name:string;terms:string;undertakings:string;content_hash:string;created_at:string;
  published_at:string|null;withdrawn_at:string|null;responded_at:string|null;signer_name:string|null;
  status:"Draft"|"Issued"|"Signed"|"Declined"|"Withdrawn";
};
export type SignatureEvidence={signer_name:string;signer_email:string;consent_version:string;responded_at:string;session_hash:string};

export const invoiceColumns="i.*,c.reference AS case_reference";
export const agreementColumns=`v.id,v.org_id,v.agreement_id,g.case_id,g.customer_id,c.reference AS case_reference,
  v.version,v.title,v.issuer_name,v.terms,v.undertakings,v.content_hash,v.created_at,v.published_at,v.withdrawn_at,r.responded_at,r.signer_name,
  CASE WHEN r.decision IS NOT NULL THEN r.decision WHEN v.withdrawn_at IS NOT NULL THEN 'Withdrawn'
       WHEN v.published_at IS NOT NULL THEN 'Issued' ELSE 'Draft' END AS status`;
export const agreementJoins=`FROM client_agreement_versions v JOIN client_agreements g ON g.id=v.agreement_id AND g.org_id=v.org_id
  JOIN client_cases c ON c.id=g.case_id AND c.org_id=g.org_id AND c.customer_id=g.customer_id
  LEFT JOIN client_agreement_responses r ON r.version_id=v.id AND r.org_id=v.org_id AND r.customer_id=g.customer_id`;

export function financeTerms(raw:unknown,label:string,limit:number,required=true) {
  const value=str(raw,label,limit,required).replace(/\r\n?/g,"\n").normalize("NFC");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return fail(400,`Remove unsupported characters from ${label}.`);
  return value;
}
export function agreementHash(version:Pick<AgreementVersion,"agreement_id"|"version"|"title"|"issuer_name"|"terms"|"undertakings">) {
  return digestFinance(JSON.stringify([version.agreement_id,version.version,version.title,version.issuer_name,version.terms,version.undertakings]));
}

export function financeItemRows(db:Db,invoiceIds:string[]) {
  return invoiceIds.length ? all<InvoiceItem & {invoice_id:string}>(db,`SELECT invoice_id,position,description,quantity,unit_minor,tax_bps,
    subtotal_minor,tax_minor,total_minor FROM client_invoice_items WHERE invoice_id=ANY(?::text[]) ORDER BY invoice_id,position`,invoiceIds)
    : Promise.resolve([]);
}

export function financeActivity(db:Db,caseRecord:CaseFinance,employee:string|null,action:string,entity:string,summary:string) {
  return run(db,`INSERT INTO client_finance_activity(id,org_id,case_id,customer_id,employee_id,action,entity_id,summary,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,id(),caseRecord.org_id,caseRecord.id,caseRecord.customer_id,employee,action,entity,summary,now());
}
