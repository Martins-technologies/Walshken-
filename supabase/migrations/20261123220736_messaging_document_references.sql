-- A message points to an existing document. The pointer does not grant access.
ALTER TABLE public.messages ADD COLUMN document_id text REFERENCES public.doc_entries(id);
CREATE INDEX messages_document_reference ON public.messages(document_id) WHERE document_id IS NOT NULL;
