export const clientDocumentCategories = [
  "Grade 10 certificate", "Grade 12 certificate", "Higher education", "Employment evidence", "CV or resume",
  "Passport", "Identity document", "Immigration document", "Supporting evidence", "Other requested document",
] as const;

export const clientDocumentMimes = ["application/pdf", "image/jpeg", "image/png"] as const;
export const clientDocumentAccept = ".pdf,.jpeg,.jpg,.png";
export const clientDocumentMaxSize = 3 * 1024 * 1024;
export const clientDocumentCaptureNotice = "Browser controls help deter copying. Screenshots, screen recording and photography remain possible.";

export type ClientDocumentRow = {
  id: string; category: string; description: string; request_id: string | null; review_status: string; created_at: string;
  deleted_at: string | null; current_version_id: string; version: number; filename: string; page_count: number;
  byte_size: number; scan_status: string; submitted_at: string; retain_until: string;
  hold_id: string | null; disposal_id: string | null; disposal_status: string | null;
};

export type ClientDocumentRequest = {id:string;title:string;instructions:string;due_on:string|null;status:string};
export type ClientDocumentVersionRow = {id:string;version:number;filename:string;page_count:number;byte_size:number;scan_status:string;submitted_at:string;retain_until:string};
export type ClientDocumentEvent = {id:string;version_id:string|null;action:string;detail:string;occurred_at:string;actor_kind:"Staff"|"Client"};
