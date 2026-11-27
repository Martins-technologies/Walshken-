export const clientDocumentCategories = [
  "Grade 10 certificate", "Grade 12 certificate", "Higher education", "Employment evidence", "CV or resume",
  "Passport", "Identity document", "Immigration document", "Supporting evidence", "Other requested document",
] as const;

export const clientDocumentMimes = ["application/pdf", "image/jpeg", "image/png"] as const;
export const clientDocumentAccept = ".pdf,.jpeg,.jpg,.png";
export const clientDocumentMaxSize = 3 * 1024 * 1024;
export const clientDocumentCaptureNotice = "Browser controls help deter copying. Screenshots, screen recording and photography remain possible.";
export const clientDocumentQuality = {
  "duplicate":"This file matches a submission already in this case.",
  "low-resolution":"Small image dimensions may make fine print hard to read.",
  "low-contrast":"The image may be hard to read because of low contrast.",
  "blur":"The image may be blurry. Check that the text is sharp.",
  "blank":"The image or first PDF page may be blank.",
  "unable-to-assess":"Automated readability checks were inconclusive.",
} as const;
export type ClientDocumentQualityFlag = keyof typeof clientDocumentQuality;

export const clientWatermarkPositions = ["top","center","bottom"] as const;
export type ClientWatermarkPolicy = {
  revision:number; enabled:boolean; label:string; opacity:number; position:typeof clientWatermarkPositions[number];
  repeat_mark:boolean; show_client:boolean; show_time:boolean; categories:(typeof clientDocumentCategories[number])[];
};
export const clientWatermarkDefault:ClientWatermarkPolicy = {
  revision:0,enabled:false,label:"Confidential · Walshken Immigration",opacity:17,position:"center",
  repeat_mark:true,show_client:true,show_time:true,categories:clientDocumentCategories.filter(category=>category!=="Other requested document"),
};

export type ClientDocumentRow = {
  id: string; category: string; description: string; request_id: string | null; review_status: string; created_at: string;
  deleted_at: string | null; current_version_id: string; version: number; filename: string; page_count: number;
  byte_size: number; scan_status: string; submitted_at: string; retain_until: string;
  hold_id: string | null; disposal_id: string | null; disposal_status: string | null;
  quality_flags:ClientDocumentQualityFlag[]; submitted_expiry_on:string|null; verified_expiry_on:string|null;
};

export type ClientDocumentRequest = {id:string;title:string;instructions:string;due_on:string|null;status:string;expected_category:typeof clientDocumentCategories[number]|null;needs_submission:boolean};
export type ClientDocumentVersionRow = {id:string;version:number;filename:string;page_count:number;byte_size:number;scan_status:string;submitted_at:string;retain_until:string;quality_flags:ClientDocumentQualityFlag[];submitted_expiry_on:string|null};
export type ClientDocumentEvent = {id:string;version_id:string|null;action:string;detail:string;occurred_at:string;actor_kind:"Staff"|"Client"};
