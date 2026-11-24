import { documentContext, documentEvaluation, documentEvent, documentLock, documentMask, documentsEnabled } from "./document-access";
import { permissionBit } from "./document-types";
import { all, AppError, fail, type Actor, type Db } from "./server";

export const messageDocumentsEnabled = () => documentsEnabled() && process.env.WALSHKEN_MESSAGE_DOCUMENTS_ENABLED === "1";

export async function shareMessageDocument(db: Db, actor: Actor, conversation: string, kind: string, document: string) {
  if (!messageDocumentsEnabled()) return fail(404, "Document attachments are unavailable.");
  if (actor.role === "guest" || kind === "External") return fail(403, "Document attachments are for internal conversations.");
  await documentLock(db, actor, document);
  const context = await documentContext(db, actor, document);
  if (!context.document?.current_version) return fail(409, "The document has no available version.");
  const evaluation = await documentEvaluation(db, actor);
  if (!((await documentMask(db, actor, context, 0, evaluation)) & permissionBit("forward"))) {
    return fail(403, "You do not have permission to share this document.");
  }
  const recipients = await all<Actor>(db, `SELECT e.* FROM conversation_members m JOIN employees e ON e.id=m.employee_id
    WHERE m.conversation_id=? AND e.org_id=? AND e.id<>? AND e.status='Active' AND e.employment_status<>'Ended'
    ORDER BY e.id FOR KEY SHARE OF m`, conversation, actor.org_id, actor.id);
  if (!recipients.length) return fail(409, "This conversation has no active recipients.");
  for (const recipient of recipients) {
    if (recipient.role === "guest" || !((await documentMask(db, recipient, context, 0, evaluation)) & permissionBit("view"))) {
      return fail(403, "Everyone in the conversation must already have permission to view the document. Review its access rules in Documents.");
    }
  }
  await documentEvent(db, actor, "Shared in conversation", document, "Private document reference in conversation " + conversation,
    recipients.length === 1 ? recipients[0].id : null, context.document.current_version);
}

export async function messageDocumentName(db: Db, actor: Actor, document: string, evaluation: Awaited<ReturnType<typeof documentEvaluation>>) {
  try {
    const context = await documentContext(db, actor, document);
    const view = (await documentMask(db, actor, context, 0, evaluation)) & permissionBit("view");
    return view && context.document?.current_version ? context.document.name : null;
  } catch (error) {
    if (error instanceof AppError && [403, 404, 409].includes(error.status)) return null;
    throw error;
  }
}

export async function attachableDocuments(db: Db, actor: Actor, query: string) {
  if (!messageDocumentsEnabled()) return fail(404, "Document attachments are unavailable.");
  if (actor.role === "guest") return fail(403, "Document attachments are for internal conversations.");
  const entries = await all<{ id: string }>(db, `SELECT id FROM doc_entries WHERE org_id=? AND deleted_at IS NULL
    AND revoked_at IS NULL AND current_version IS NOT NULL AND strpos(lower(name),lower(?))>0 ORDER BY updated_at DESC,id`, actor.org_id, query);
  const evaluation = await documentEvaluation(db, actor);
  const result: { id: string; name: string }[] = [];
  for (const entry of entries) {
    try {
      const context = await documentContext(db, actor, entry.id);
      const mask = await documentMask(db, actor, context, 0, evaluation);
      if (mask & permissionBit("forward")) result.push({ id: entry.id, name: context.document!.name });
      if (result.length === 50) break;
    } catch (error) {
      if (!(error instanceof AppError) || ![403, 404, 409].includes(error.status)) throw error;
    }
  }
  return result;
}
