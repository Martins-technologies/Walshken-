"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowUpRight, CheckCircle2, ChevronRight, CreditCard, Download, FileCheck2, FileText,
  LockKeyhole, Plus, Receipt, RefreshCw, Trash2, X,
} from "lucide-react";
import { dateText } from "./ui";
import styles from "./client-finance.module.css";

type InvoiceLine = { description: string; quantity: number; unit_minor: number; tax_bps: number; total_minor: number };
type Invoice = {
  id: string; case_id: string; case_reference: string; invoice_number: string | null;
  issuer_name: string; issuer_address: string; issuer_tax_number: string | null;
  subtotal_minor: number; tax_minor: number; total_minor: number; currency: string;
  issue_on: string | null; due_on: string; status: "Draft" | "Open" | "Processing" | "Paid" | "Void";
  items: InvoiceLine[];
};
type Payment = {
  id: string; invoice_id: string; invoice_number: string; amount_minor: number; currency: string;
  status: "Creating" | "Pending" | "Processing" | "Paid" | "Failed" | "Expired";
  provider_reference: string | null; receipt_number: string | null; created_at: string; confirmed_at: string | null; sandbox: boolean;
};
type Agreement = {
  id: string; agreement_id: string; case_id: string; case_reference: string; title: string; version: number;
  terms: string; undertakings: string; issuer_name: string; status: "Draft" | "Issued" | "Signed" | "Declined" | "Withdrawn";
  created_at: string; published_at: string | null; responded_at: string | null; signer_name: string | null; content_hash: string;
};
type FinanceActivity = { action: string; entity_id: string; summary: string; created_at: string };
type FinanceData = {
  invoices: Invoice[]; payments: Payment[]; agreements: Agreement[];
  checkoutMode: "sandbox" | "live" | "unconfigured"; canManage?: boolean; activity?: FinanceActivity[];
};
type RequestResult = { message?: string; url?: string };
type Notice = { text: string; error: boolean };
type DownloadKind = "invoice" | "receipt" | "agreement";
type StaffDialog =
  | { type: "invoice-form"; invoice?: Invoice }
  | { type: "agreement-form"; agreement?: Agreement }
  | { type: "invoice-view"; invoice: Invoice }
  | { type: "agreement-view"; agreement: Agreement }
  | { type: "invoice-issue" | "invoice-void" | "agreement-publish" | "agreement-withdraw"; id: string; label: string };
type ClientDialog =
  | { type: "invoice"; invoice: Invoice }
  | { type: "agreement"; agreement: Agreement };

const endpoint = "/api/client-finance";
const currencies = ["CAD", "USD", "INR", "PKR", "GBP", "EUR"] as const;

async function fetchFinance<T>(url: string, input?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const result = await fetch(url, {
    cache: "no-store", signal,
    ...(input ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const payload = await result.json().catch(() => null) as { error?: string } | null;
  if (!result.ok || !payload) throw new Error(payload?.error || "This request could not be completed. Try again.");
  return payload as T;
}

function useFinance(caseId?: string) {
  const readEndpoint = caseId ? endpoint + "/staff?" + new URLSearchParams({ caseId }) : endpoint;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ url: string; data?: FinanceData; error?: string }>();
  const [notice, setNotice] = useState<Notice>();
  const [pending, setPending] = useState(false);
  const active = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchFinance<FinanceData>(readEndpoint, undefined, controller.signal).then(
      data => { if (!controller.signal.aborted) setState({ url: readEndpoint, data }); },
      error => { if (!controller.signal.aborted) setState({ url: readEndpoint, error: (error as Error).message }); },
    );
    return () => controller.abort();
  }, [readEndpoint, version]);

  function refresh() { setVersion(value => value + 1); }
  async function mutate(input: Record<string, unknown>, before?: () => Promise<unknown>) {
    if (active.current) return;
    active.current = true;
    setPending(true);
    setNotice(undefined);
    try {
      if (before) await before();
      const result = await fetchFinance<RequestResult>(
        caseId ? endpoint + "/staff" : endpoint, caseId ? { ...input, caseId } : input,
      );
      if (input.action === "checkout") {
        const checkout = new URL(result.url || "");
        if (checkout.protocol !== "https:" || checkout.hostname !== "checkout.stripe.com" || checkout.username || checkout.password || checkout.port) {
          throw new Error("The payment provider returned an invalid checkout link.");
        }
        window.location.assign(checkout.href);
      } else {
        setNotice({ text: result.message || "Changes saved.", error: false });
        refresh();
      }
      return result;
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "This request could not be completed.", error: true });
    } finally {
      active.current = false;
      setPending(false);
    }
  }
  return {
    data: state?.url === readEndpoint ? state.data : undefined,
    error: state?.url === readEndpoint ? state.error : undefined,
    notice, pending, refresh, mutate, clearNotice: () => setNotice(undefined),
  };
}

function amount(minor: number, currency: string) {
  return new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "code" }).format(minor / 100);
}

function Status({ value }: { value: string }) {
  const tone = /^(Paid|Signed)$/.test(value) ? "good" : /^(Failed|Void|Declined|Withdrawn)$/.test(value) ? "risk"
    : /^(Open|Issued|Creating|Pending|Processing)$/.test(value) ? "wait" : "neutral";
  const name = ({ Open: "Payment due", Issued: "Awaiting signature", Creating: "Starting checkout" } as Record<string, string>)[value] || value;
  return <span className={styles.status} data-tone={tone}>{name}</span>;
}

function Feedback({ notice }: { notice?: Notice }) {
  if (!notice) return null;
  return <p role={notice.error ? "alert" : "status"} className={notice.error ? styles.error : styles.success}>
    {notice.error ? null : <CheckCircle2 size={17} aria-hidden="true"/>}{notice.text}
  </p>;
}

function downloadHref(kind: DownloadKind, id: string, caseId?: string) {
  return endpoint + (caseId ? "/staff?" : "?") + new URLSearchParams({ kind, id, ...(caseId ? { caseId } : {}) });
}

function PdfLink({ kind, id, text, caseId }: { kind: DownloadKind; id: string; text?: string; caseId?: string }) {
  return <a className={styles.link} href={downloadHref(kind, id, caseId)}>
    <Download size={16} aria-hidden="true"/>{text ?? (kind === "receipt" ? "Download receipt" : kind === "agreement" ? "Download agreement" : "Download invoice")}
  </a>;
}

function Empty({ title, body, textIcon }: { title: string; body: string; textIcon?: boolean }) {
  const Icon = textIcon ? FileCheck2 : Receipt;
  return <div className={styles.empty}>
    <span className={styles.tile}><Icon size={21} aria-hidden="true"/></span>
    <strong>{title}</strong><p>{body}</p>
  </div>;
}

function Frame({ children, label, count, action }: { children: ReactNode; label: string; count?: number; action?: ReactNode }) {
  const heading = useId();
  return <section className={styles.frame} aria-labelledby={heading}>
    <header className={styles.frameHeader}>
      <div className={styles.heading}>{<h2 id={heading}>{label}</h2>}{count !== undefined && <span>{count}</span>}</div>
      {action}
    </header>
    {children}
  </section>;
}

function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const modal = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const node = modal.current;
    if (!node) return;
    node.showModal();
    return () => { if (node.open) node.close(); };
  }, []);
  return <dialog ref={modal} className={styles.dialog} aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }}>
    <header className={styles.dialogHeader}><h2 id={id}>{title}</h2>
      <button type="button" className={styles.iconButton} aria-label="Close dialog" onClick={close}><X size={21}/></button>
    </header>
    <div className={styles.dialogBody}>{children}</div>
  </dialog>;
}

function InvoiceBreakdown({ invoice }: { invoice: Invoice }) {
  return <>
    <div className={styles.invoiceMeta}>
      <div><strong>{invoice.issuer_name}</strong><p className={styles.bodyText}>{invoice.issuer_address}</p>
        {invoice.issuer_tax_number && <small>Tax registration {invoice.issuer_tax_number}</small>}
      </div>
      <dl><div><dt>Case</dt><dd>{invoice.case_reference}</dd></div>
        {invoice.issue_on && <div><dt>Issued</dt><dd>{dateText(invoice.issue_on)}</dd></div>}
        <div><dt>Due</dt><dd>{dateText(invoice.due_on)}</dd></div></dl>
    </div>
    <ul className={styles.breakdown} aria-label="Invoice line items">
      {invoice.items.map((item, index) => <li key={index}>
        <div><strong>{item.description}</strong><small>{item.quantity} × {amount(item.unit_minor, invoice.currency)}
          {item.tax_bps > 0 && <> · {item.tax_bps / 100}% tax</>}</small></div>
        <strong>{amount(item.total_minor, invoice.currency)}</strong>
      </li>)}
    </ul>
    <dl className={styles.totals}>
      <div><dt>Subtotal</dt><dd>{amount(invoice.subtotal_minor, invoice.currency)}</dd></div>
      <div><dt>Tax</dt><dd>{amount(invoice.tax_minor, invoice.currency)}</dd></div>
      <div><dt>Total</dt><dd>{amount(invoice.total_minor, invoice.currency)}</dd></div>
    </dl>
  </>;
}

function InvoiceList({ invoices, empty, select, actions }: {
  invoices: Invoice[]; empty: string; select: (invoice: Invoice) => void; actions?: (invoice: Invoice) => ReactNode;
}) {
  if (!invoices.length) return <Empty title="No invoices" body={empty}/>;
  return <ul className={styles.records} aria-label="Invoices">
    {invoices.map(invoice => <li key={invoice.id} className={styles.record}>
      <span className={styles.tile}><FileText size={20} aria-hidden="true"/></span>
      <div className={styles.recordPrimary}>
        <button type="button" className={styles.rowTitle} onClick={() => select(invoice)}>{invoice.invoice_number || "Draft invoice"}<ChevronRight size={15} aria-hidden="true"/></button>
        <p>{invoice.case_reference} · Due {dateText(invoice.due_on)}</p>
      </div>
      <div className={styles.recordAmount}><strong>{amount(invoice.total_minor, invoice.currency)}</strong><Status value={invoice.status}/></div>
      {actions && <div className={styles.rowActions}>{actions(invoice)}</div>}
    </li>)}
  </ul>;
}

function PaymentHistory({ payments, caseId, refresh }: { payments: Payment[]; caseId?: string; refresh: () => void }) {
  return <Frame label="Payment history" count={payments.length} action={payments.some(payment => /^(Creating|Pending|Processing)$/.test(payment.status)) &&
    <button type="button" className={styles.link} onClick={refresh}><RefreshCw size={15}/>Refresh status</button>}>
    {!payments.length ? <Empty title="No payment activity" body="Records from secure checkout will appear here."/> :
      <ul className={styles.records} aria-label="Payments">
        {payments.map(payment => <li className={styles.record} key={payment.id}>
          <span className={styles.tile}><CreditCard size={18} aria-hidden="true"/></span>
          <div className={styles.recordPrimary}>
            <strong>{payment.invoice_number}</strong>
            <p>{dateText(payment.confirmed_at || payment.created_at, true)}{payment.sandbox ? " · Test transaction" : ""}</p>
            {payment.provider_reference && <small className={styles.reference}>Reference {payment.provider_reference}</small>}
          </div>
          <div className={styles.recordAmount}><strong>{amount(payment.amount_minor, payment.currency)}</strong><Status value={payment.status}/></div>
          {payment.status === "Paid" && payment.receipt_number && <div className={styles.rowActions}>
            <PdfLink kind="receipt" id={payment.id} caseId={caseId}/>
          </div>}
        </li>)}
      </ul>}
  </Frame>;
}

function AgreementList({ agreements, select, actions }: {
  agreements: Agreement[]; select: (agreement: Agreement) => void; actions?: (agreement: Agreement) => ReactNode;
}) {
  if (!agreements.length) return <Empty textIcon title="No agreements" body="Agreements appear here when Walshken makes them available for this account." />;
  return <ul className={styles.records} aria-label="Agreements">
    {agreements.map(agreement => <li key={agreement.id} className={styles.record}>
      <span className={styles.tile}><FileCheck2 size={20} aria-hidden="true"/></span>
      <div className={styles.recordPrimary}>
        <button type="button" className={styles.rowTitle} onClick={() => select(agreement)}>{agreement.title}<ChevronRight size={15} aria-hidden="true"/></button>
        <p>Version {agreement.version} · {agreement.case_reference}</p>
        {agreement.published_at && <small>Issued {dateText(agreement.published_at)}</small>}
      </div>
      <div className={styles.recordAmount}><Status value={agreement.status}/></div>
      {actions && <div className={styles.rowActions}>{actions(agreement)}</div>}
    </li>)}
  </ul>;
}

function AgreementTerms({ agreement }: { agreement: Agreement }) {
  return <>
    <div className={styles.agreementInfo}>
      <p>{agreement.issuer_name} · Version {agreement.version} · {agreement.case_reference}</p><Status value={agreement.status}/>
    </div>
    <div className={styles.terms}>
      <h3>Terms and conditions</h3><p className={styles.bodyText}>{agreement.terms}</p>
      {agreement.undertakings && <><h3>Undertakings</h3><p className={styles.bodyText}>{agreement.undertakings}</p></>}
    </div>
    {agreement.responded_at && <div className={styles.paymentNote}>
      {agreement.signer_name && <span>{agreement.status === "Signed" ? "Signed by " : "Response by "}{agreement.signer_name}.</span>}{" "}
      Recorded {dateText(agreement.responded_at, true)}.
    </div>}
  </>;
}

function AgreementResponse({ agreement, busy, answer }: {
  agreement: Agreement; busy: boolean;
  answer: (data: Record<string, unknown>, before: () => Promise<unknown>) => Promise<RequestResult | undefined>;
}) {
  const [response, setResponse] = useState<"sign" | "decline">();
  if (!response) return <div className={styles.actionBar}>
    <button type="button" className="btn btn-blue" onClick={() => setResponse("sign")}>Review and sign</button>
    <button type="button" className="btn btn-outline" onClick={() => setResponse("decline")}>Decline agreement</button>
  </div>;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = fields.get("password");
    const passwordInput = form.elements.namedItem("password") as HTMLInputElement | null;
    if (passwordInput) passwordInput.value = "";
    const result = await answer({
      action: response === "sign" ? "agreement-sign" : "agreement-decline",
      id: agreement.id, contentHash: agreement.content_hash, name: fields.get("name"),
      consent: response === "sign" && fields.has("consent"), reason: fields.get("reason"),
    }, () => fetchFinance("/api/customer/reauthenticate", { password }));
    if (!result) passwordInput?.focus();
  }
  return <form className={styles.form} onSubmit={submit} aria-busy={busy}>
    <h3>{response === "sign" ? "Provide your electronic signature" : "Confirm your decision"}</h3>
    <div className={styles.fields}>
      <label>Name on your verified account<input name="name" autoComplete="name" minLength={2} maxLength={160} required/></label>
      <label>Account password<input name="password" type="password" autoComplete="current-password" maxLength={160} required/></label>
    </div>
    {response === "sign" ? <label className={styles.checkField}><input name="consent" type="checkbox" required/>
      <span>I have reviewed this exact agreement version. I intend to sign electronically and agree to its terms and undertakings.</span></label>
      : <label>Reason <small>Optional</small><textarea name="reason" maxLength={500} rows={3}/></label>}
    <div className={styles.actionBar}>
      <button className={response === "sign" ? "btn btn-blue" : "btn btn-danger"} disabled={busy}>{busy ? "Submitting…" : response === "sign" ? "Sign agreement" : "Confirm decline"}</button>
      <button type="button" className="btn btn-outline" onClick={() => setResponse(undefined)} disabled={busy}>Back</button>
    </div>
  </form>;
}

export function ClientFinance({ section }: { section: "payments" | "agreements" }) {
  const finance = useFinance();
  const { data, error, notice, pending, mutate, refresh, clearNotice } = finance;
  const [dialog, setDialog] = useState<ClientDialog>();
  const [checkout, setCheckout] = useState<string>();
  const close = () => { setDialog(undefined); clearNotice(); };

  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("checkout");
    if (query === "return" || query === "cancel") setCheckout(query);
  }, []);

  if (error) return <div className={styles.root}><Feedback notice={{ text: error, error: true }}/>
    <button className="btn btn-outline" onClick={refresh}><RefreshCw size={16}/>Retry</button>
  </div>;
  if (!data) return <p className={styles.loading} role="status">Loading {section === "payments" ? "billing records" : "agreements"}…</p>;
  const balances = new Map<string, number>();
  for (const invoice of data.invoices) {
    if (invoice.status === "Open" || invoice.status === "Processing") {
      balances.set(invoice.currency, (balances.get(invoice.currency) || 0) + invoice.total_minor);
    }
  }
  const paymentAllowed = data.checkoutMode !== "unconfigured";
  const invoicesDue = data.invoices.filter(invoice => invoice.status === "Open").length;
  const pay = (invoice: Invoice) => void mutate({ action: "checkout", id: invoice.id });
  const payLabel = (invoice: Invoice) => data.payments.some(payment => payment.invoice_id === invoice.id && payment.status === "Pending")
    ? "Continue checkout" : "Pay securely";

  return <div className={styles.root}>
    {!dialog && <Feedback notice={notice}/>}
    {section === "payments" ? <>
      {checkout && <div className={styles.paymentNote} role="status">
        <span>{checkout === "return" ? "You returned from checkout. Confirmed payment status and receipts appear here after the payment provider verifies your transaction."
          : "Checkout was closed. Your invoice and payment status are shown below."}</span>
        <button type="button" className={styles.link} onClick={refresh}><RefreshCw size={15}/>Refresh status</button>
      </div>}
      <section className={styles.summary} aria-label="Outstanding balances">
        <span className={styles.tile}><CreditCard size={25} aria-hidden="true"/></span>
        <div>
          <h2>Outstanding balance</h2>
          {balances.size ? <ul>{[...balances].map(([currency, total]) => <li key={currency}>{amount(total, currency)}</li>)}</ul>
            : <strong>No balance due</strong>}
          {invoicesDue > 0 && <p>{invoicesDue} {invoicesDue === 1 ? "invoice" : "invoices"} awaiting payment</p>}
        </div>
        {data.checkoutMode === "sandbox" && <span className={styles.sandbox}>Stripe test checkout</span>}
      </section>
      {invoicesDue > 0 && !paymentAllowed && <p className={styles.paymentNote}><LockKeyhole size={17} aria-hidden="true"/> Online checkout is unavailable. Contact your assigned representative about these invoices.</p>}
      <Frame label="Invoices" count={data.invoices.length}>
        <InvoiceList invoices={data.invoices} empty="Invoices from Walshken will appear here." select={invoice => { clearNotice(); setDialog({ type: "invoice", invoice }); }}
          actions={invoice => <>
            <PdfLink kind="invoice" id={invoice.id}/>
            {invoice.status === "Open" && paymentAllowed && <button type="button" className="btn btn-blue btn-small" disabled={pending} onClick={() => pay(invoice)}>
              {payLabel(invoice)}<ArrowUpRight size={15}/></button>}
          </>}/>
      </Frame>
      <PaymentHistory payments={data.payments} refresh={refresh}/>
    </> : <Frame label="Agreements" count={data.agreements.length}>
      <AgreementList agreements={data.agreements}
        select={agreement => { clearNotice(); setDialog({ type: "agreement", agreement }); }}
        actions={agreement => agreement.status === "Signed"
          ? <PdfLink kind="agreement" id={agreement.id} text="Download signed copy"/>
          : <button type="button" className="btn btn-outline btn-small" onClick={() => { clearNotice(); setDialog({ type: "agreement", agreement }); }}>View agreement</button>}/>
    </Frame>}
    {dialog?.type === "invoice" && <Dialog title={dialog.invoice.invoice_number || "Invoice details"} close={close}>
      <InvoiceBreakdown invoice={dialog.invoice}/>
      <Feedback notice={notice}/>
      <div className={styles.actionBar}>
        <PdfLink kind="invoice" id={dialog.invoice.id}/>
        {dialog.invoice.status === "Open" && paymentAllowed &&
          <button type="button" className="btn btn-blue" disabled={pending} onClick={() => pay(dialog.invoice)}>{payLabel(dialog.invoice)}<ArrowUpRight size={16}/></button>}
      </div>
    </Dialog>}
    {dialog?.type === "agreement" && <Dialog title={dialog.agreement.title} close={close}>
      <AgreementTerms agreement={dialog.agreement}/>
      <Feedback notice={notice}/>
      {dialog.agreement.status !== "Draft" && <PdfLink kind="agreement" id={dialog.agreement.id}
        text={dialog.agreement.status === "Signed" ? "Download signed copy" : "Download agreement"}/>}
      {dialog.agreement.status === "Issued" && <AgreementResponse agreement={dialog.agreement} busy={pending} answer={async (input, before) => {
        const result = await mutate(input, before);
        if (result) setDialog(undefined);
        return result;
      }}/>}
    </Dialog>}
  </div>;
}

type EditLine = { key: number; description: string; quantity: string; price: string; tax: string };
const blankLine = (key: number): EditLine => ({ key, description: "", quantity: "1", price: "", tax: "0" });
function toMinor(raw: string) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fractions = ""] = raw.split(".");
  return Number(whole) * 100 + Number(fractions.padEnd(2, "0"));
}

function InvoiceForm({ invoice, pending, save }: {
  invoice?: Invoice; pending: boolean; save: (data: Record<string, unknown>) => Promise<unknown>;
}) {
  const [lines, setLines] = useState<EditLine[]>(() => invoice?.items.length ? invoice.items.map((item, key) => ({
    key, description: item.description, quantity: String(item.quantity), price: (item.unit_minor / 100).toFixed(2), tax: String(item.tax_bps / 100),
  })) : [blankLine(0)]);
  const nextLine = useRef(lines.length);
  const [currency, setCurrency] = useState(invoice?.currency || "CAD");
  const [error, setError] = useState("");

  function change(key: number, field: keyof Omit<EditLine, "key">, value: string) {
    setLines(prior => prior.map(item => item.key === key ? { ...item, [field]: value } : item));
  }
  const estimate = lines.reduce((sum, line) => {
    const price = toMinor(line.price) ?? 0, quantity = Number(line.quantity) || 0, taxBps = toMinor(line.tax) ?? 0;
    return sum + price * quantity + Math.round(price * quantity * taxBps / 10_000);
  }, 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const fields = new FormData(event.currentTarget);
    if (lines.some(line => toMinor(line.price) === null || toMinor(line.tax) === null ||
      !Number.isSafeInteger(Number(line.quantity)) || Number(line.quantity) < 1 || Number(line.quantity) > 10000)) {
      setError("Enter a whole quantity and amounts with up to two decimal places.");
      return;
    }
    if (estimate <= 0 || estimate > 99_999_999) {
      setError("Enter a positive invoice total of up to " + amount(99_999_999, currency) + ".");
      return;
    }
    await save({
      action: "invoice-save", id: invoice?.id, issuerName: fields.get("issuerName"), issuerAddress: fields.get("issuerAddress"),
      issuerTaxNumber: fields.get("issuerTaxNumber"), dueOn: fields.get("dueOn"), currency,
      items: lines.map(line => ({ description: line.description, quantity: Number(line.quantity), unitMinor: toMinor(line.price), taxBps: toMinor(line.tax) })),
    });
  }
  return <form className={styles.form} onSubmit={submit} aria-busy={pending}>
    <div className={styles.fields}>
      <label>Legal issuer name<input name="issuerName" maxLength={180} defaultValue={invoice?.issuer_name} required/></label>
      <label>Tax registration number <small>Optional</small><input name="issuerTaxNumber" maxLength={100} defaultValue={invoice?.issuer_tax_number || ""}/></label>
      <label className={styles.wide}>Issuer address<textarea name="issuerAddress" maxLength={500} defaultValue={invoice?.issuer_address} rows={3} required/></label>
      <label>Currency<select value={currency} onChange={event => setCurrency(event.target.value)}>
        {currencies.map(code => <option key={code} value={code}>{code}</option>)}</select></label>
      <label>Due date<input type="date" name="dueOn" defaultValue={invoice?.due_on} required/></label>
    </div>
    <fieldset className={styles.lineItems}>
      <legend>Invoice line items</legend>
      {lines.map((line, index) => <div className={styles.lineItem} key={line.key}>
        <label>Description<input value={line.description} maxLength={250} required onChange={event => change(line.key, "description", event.target.value)}/></label>
        <label>Quantity<input type="number" value={line.quantity} min={1} max={10000} step={1} required onChange={event => change(line.key, "quantity", event.target.value)}/></label>
        <label>Unit price<input inputMode="decimal" type="number" min={0} max={999999.99} step=".01" value={line.price} required onChange={event => change(line.key, "price", event.target.value)}/></label>
        <label>Tax %<input inputMode="decimal" type="number" min={0} max={100} step=".01" value={line.tax} required onChange={event => change(line.key, "tax", event.target.value)}/></label>
        {lines.length > 1 && <button type="button" className={styles.iconButton} aria-label={"Remove line " + (index + 1)} onClick={() => setLines(prior => prior.filter(item => item.key !== line.key))}><Trash2 size={18}/></button>}
      </div>)}
      <button type="button" className="btn btn-outline btn-small" disabled={lines.length >= 40} onClick={() => {
        const line = blankLine(nextLine.current++);
        setLines(prior => [...prior, line]);
      }}><Plus size={15}/>Add line item</button>
    </fieldset>
    <div className={styles.estimate}><span>Estimated total</span><strong>{amount(estimate, currency)}</strong></div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actionBar}><button className="btn btn-blue" disabled={pending}>{pending ? "Saving…" : "Save invoice draft"}</button></div>
  </form>;
}

function AgreementForm({ agreement, pending, save }: {
  agreement?: Agreement; pending: boolean; save: (data: Record<string, unknown>) => Promise<unknown>;
}) {
  return <form className={styles.form} aria-busy={pending} onSubmit={event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void save({
      action: "agreement-save", agreementId: agreement?.agreement_id, title: values.get("title"),
      issuerName: values.get("issuerName"), terms: values.get("terms"), undertakings: values.get("undertakings"),
    });
  }}>
    <div className={styles.fields}>
      <label>Agreement title<input name="title" defaultValue={agreement?.title} maxLength={150} required/></label>
      <label>Legal issuer name<input name="issuerName" defaultValue={agreement?.issuer_name} maxLength={180} required/></label>
    </div>
    <label>Terms and conditions<textarea name="terms" rows={9} defaultValue={agreement?.terms} maxLength={20000} required/></label>
    <label>Undertakings <small>Optional</small><textarea name="undertakings" rows={4} defaultValue={agreement?.undertakings} maxLength={5000}/></label>
    <p>Review the full text before publishing it to the client.</p>
    <div className={styles.actionBar}><button className="btn btn-blue" disabled={pending}>{pending ? "Saving…" : "Save draft version"}</button></div>
  </form>;
}

const decisions = {
  "invoice-issue": { title: "Issue invoice", description: "The client can review the invoice and will receive a portal notification.", reason: false, destructive: false },
  "invoice-void": { title: "Void invoice", description: "Record why this invoice should no longer be collected.", reason: true, destructive: true },
  "agreement-publish": { title: "Publish agreement", description: "This version will be made available to the client for their decision.", reason: false, destructive: false },
  "agreement-withdraw": { title: "Withdraw agreement", description: "Record why this version should no longer accept a response.", reason: true, destructive: true },
} as const;

export function StaffClientFinance({ caseId }: { caseId: string }) {
  const { data, error, notice, pending, mutate, refresh, clearNotice } = useFinance(caseId);
  const [view, setView] = useState<"invoices" | "agreements">("invoices");
  const [dialog, setDialog] = useState<StaffDialog>();
  const open = (value: StaffDialog) => { clearNotice(); setDialog(value); };
  const close = () => { clearNotice(); setDialog(undefined); };
  const save = async (input: Record<string, unknown>) => { if (await mutate(input)) setDialog(undefined); };

  if (error) return <section className={styles.root} aria-label="Case finance">
    <Feedback notice={{ text: error, error: true }}/><button type="button" className="btn btn-outline btn-small" onClick={refresh}>Retry</button>
  </section>;
  if (!data) return <p className={styles.loading} role="status">Loading case finance and agreements…</p>;
  const decision = dialog && dialog.type in decisions ? decisions[dialog.type as keyof typeof decisions] : null;
  const latestVersions = new Map<string, number>();
  for (const agreement of data.agreements) {
    latestVersions.set(agreement.agreement_id, Math.max(agreement.version, latestVersions.get(agreement.agreement_id) ?? 0));
  }

  return <section className={styles.root} aria-label="Case finance and agreements">
    {!dialog && <Feedback notice={notice}/>}
    <nav className={styles.segment} aria-label="Case finance sections">
      <button type="button" aria-pressed={view === "invoices"} onClick={() => setView("invoices")}><Receipt size={16}/>Invoices and payments</button>
      <button type="button" aria-pressed={view === "agreements"} onClick={() => setView("agreements")}><FileCheck2 size={16}/>Agreements</button>
    </nav>
    {view === "invoices" ? <>
      {data.checkoutMode === "unconfigured" && data.canManage && <p className={styles.paymentNote}>
        <LockKeyhole size={17} aria-hidden="true"/> Configure Stripe in Admin Integrations to activate online checkout.
      </p>}
      <Frame label="Case invoices" count={data.invoices.length} action={data.canManage ? <button type="button" className="btn btn-blue btn-small" onClick={() => open({ type: "invoice-form" })}>
        <Plus size={16}/>New invoice</button> : undefined}>
        <InvoiceList invoices={data.invoices} empty="Invoices for this case will appear here." select={invoice => open({ type: "invoice-view", invoice })}
          actions={invoice => <>
            {invoice.status !== "Draft" && <PdfLink kind="invoice" id={invoice.id} caseId={caseId}/>}
            {data.canManage && invoice.status === "Draft" && <>
              <button type="button" className="btn btn-outline btn-small" onClick={() => open({ type: "invoice-form", invoice })}>Edit draft</button>
              <button type="button" className="btn btn-blue btn-small" onClick={() => open({ type: "invoice-issue", id: invoice.id, label: "Draft invoice" })}>Issue</button>
            </>}
            {data.canManage && invoice.status === "Open" && !data.payments.some(payment => payment.invoice_id === invoice.id && /^(Creating|Pending|Processing|Paid)$/.test(payment.status)) && <button type="button" className={styles.danger}
              onClick={() => open({ type: "invoice-void", id: invoice.id, label: invoice.invoice_number || "Draft invoice" })}>Void</button>}
          </>}/>
      </Frame>
      <PaymentHistory payments={data.payments} caseId={caseId} refresh={refresh}/>
    </> : <Frame label="Case agreements" count={data.agreements.length} action={data.canManage ? <button type="button" className="btn btn-blue btn-small" onClick={() => open({ type: "agreement-form" })}><Plus size={16}/>New agreement</button> : undefined}>
      <AgreementList agreements={data.agreements} select={agreement => open({ type: "agreement-view", agreement })}
        actions={agreement => {
          const latest = agreement.version === latestVersions.get(agreement.agreement_id);
          return <>
            {agreement.status !== "Draft" && <PdfLink kind="agreement" id={agreement.id} caseId={caseId} text={agreement.status === "Signed" ? "Download signed copy" : "Download agreement"}/>}
            {data.canManage && latest && <button type="button" className="btn btn-outline btn-small" onClick={() => open({ type: "agreement-form", agreement })}>New version</button>}
            {data.canManage && latest && agreement.status === "Draft" && <button type="button" className="btn btn-blue btn-small" onClick={() => open({ type: "agreement-publish", id: agreement.id, label: agreement.title })}>Publish</button>}
            {data.canManage && agreement.status === "Issued" && <button type="button" className={styles.danger} onClick={() => open({ type: "agreement-withdraw", id: agreement.id, label: agreement.title })}>Withdraw</button>}
          </>;
        }}/>
    </Frame>}
    {!!data.activity?.length && <Frame label="Finance activity">
      <ul className={styles.records} aria-label="Audited finance activity">{data.activity.map((entry, index) =>
        <li key={entry.entity_id + entry.created_at + index} className={styles.record}>
          <span className={styles.tile}><FileCheck2 size={17} aria-hidden="true"/></span>
          <div className={styles.recordPrimary}><strong>{entry.action}</strong><p>{entry.summary}</p></div>
          <small>{dateText(entry.created_at, true)}</small>
        </li>)}
      </ul>
    </Frame>}
    {dialog && <Dialog close={close} title={
      decision?.title ?? (dialog.type === "invoice-form" ? dialog.invoice ? "Edit invoice draft" : "Create invoice"
        : dialog.type === "agreement-form" ? dialog.agreement ? "Draft a new version" : "Create agreement"
        : dialog.type === "invoice-view" ? dialog.invoice.invoice_number || "Invoice details"
        : dialog.type === "agreement-view" ? dialog.agreement.title : "Confirm action")
    }>
      <Feedback notice={notice}/>
      {dialog.type === "invoice-form" && <InvoiceForm invoice={dialog.invoice} pending={pending} save={save}/>}
      {dialog.type === "agreement-form" && <AgreementForm agreement={dialog.agreement} pending={pending} save={save}/>}
      {dialog.type === "invoice-view" && <InvoiceBreakdown invoice={dialog.invoice}/>}
      {dialog.type === "agreement-view" && <AgreementTerms agreement={dialog.agreement}/>}
      {decision && "id" in dialog && <form className={styles.form} onSubmit={event => {
        event.preventDefault();
        void save({ action: dialog.type, id: dialog.id, reason: new FormData(event.currentTarget).get("reason") });
      }}>
        <p><strong>{dialog.label}</strong> · {decision.description}</p>
        {decision.reason && <label>Reason<textarea rows={3} name="reason" maxLength={500} required/></label>}
        <div className={styles.actionBar}>
          <button className={decision.destructive ? "btn btn-danger" : "btn btn-blue"} disabled={pending}>{pending ? "Saving…" : decision.title}</button>
          <button type="button" className="btn btn-outline" onClick={close} disabled={pending}>Cancel</button>
        </div>
      </form>}
    </Dialog>}
  </section>;
}
