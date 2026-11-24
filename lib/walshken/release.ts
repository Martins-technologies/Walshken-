// Production exposes the features delivered through staff collaboration.
// Later modules stay gated until their own acceptance and deployment.
export const collaborationRelease=()=>["staff-collaboration","staff-documents","staff-tasks","staff-attendance","staff-payroll","staff-holidays"].includes(process.env.WALSHKEN_RELEASE_SCOPE??"");
export const releasedSections=new Set(["dashboard","work-policies","profile","directory","notifications","messages","calls","projects","calendar","employees","departments","roles","audit","integrations","website","countries"]);
export const releasedMutationAreas=new Set(["session","mfa","profile","employees","organization","website","integrations","communication-policy","messages","calls","projects","notifications"]);
