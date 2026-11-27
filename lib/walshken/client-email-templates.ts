export const clientNoticeTypes = [
  "security","case","document","payment","invoice","agreement","call","announcement","appointment","payment-reminder","meeting-reminder",
] as const;
export type ClientNoticeType=typeof clientNoticeTypes[number];

const links:Record<ClientNoticeType,string>={
  security:"/customer/security", case:"/customer/cases", document:"/customer/documents", payment:"/customer/payments",
  invoice:"/customer/payments", agreement:"/customer/agreements", call:"/customer/contact", announcement:"/customer/notifications",
  appointment:"/customer/appointments", "payment-reminder":"/customer/payments", "meeting-reminder":"/customer/appointments",
};
const subjects:Record<ClientNoticeType,string>={
  security:"Walshken account security alert",case:"An update is available for your Walshken case",
  document:"Walshken document update",payment:"Walshken payment update",invoice:"Your Walshken invoice is available",
  agreement:"Walshken agreement update",call:"Walshken call activity",announcement:"A new announcement from Walshken",
  appointment:"Walshken appointment update","payment-reminder":"Walshken payment reminder","meeting-reminder":"Walshken meeting reminder",
};
export function clientNoticeEmail(kind:ClientNoticeType,origin:string){
  const body=kind==="security"?"An account security event occurred. Review it in your client portal.":"Sign in to your Walshken client portal to see the details.";
  return {subject:subjects[kind],text:body+"\n\n"+origin+links[kind]};
}
