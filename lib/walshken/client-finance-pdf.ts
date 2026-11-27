import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {PDFDocument,rgb,type PDFFont} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {electronicConsent,type AgreementVersion,type Invoice,type InvoiceItem,type Payment,type SignatureEvidence} from "./client-finance-records";

export const financeMoney=(amount:number,currency:string)=>new Intl.NumberFormat("en-CA",{
  style:"currency",currency,currencyDisplay:"code",minimumFractionDigits:2,maximumFractionDigits:2,
}).format(amount/100);

type Line={text:string;size?:number;space?:number};
function blocks(input:string,font:PDFFont,size:number) {
  const output:string[]=[];
  for(const paragraph of input.replace(/[\x00-\x09\x0b-\x1f\x7f]/g," ").split("\n")){
    let line="";
    for(const word of paragraph.split(/\s+/).filter(Boolean)){
      if(line && font.widthOfTextAtSize(line+" "+word,size)>497){output.push(line);line="";}
      if(font.widthOfTextAtSize(word,size)>497){
        let part="";
        for(const character of word){
          if(part&&font.widthOfTextAtSize(part+character,size)>497){output.push(part);part="";}
          part+=character;
        }
        line=part;
      }else line+=(line?" ":"")+word;
    }
    output.push(line);
  }
  return output;
}

async function financePdf(title:string,issuer:string,lines:Line[]) {
  const pdf=await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font=await pdf.embedFont(await readFile(join(process.cwd(),"public/payroll-font.ttf")),{subset:true});
  pdf.setTitle(title);pdf.setAuthor(issuer);
  const ink=rgb(.07,.12,.25),accent=rgb(.15,.32,.69);
  let page=pdf.addPage([595,842]),y=790;
  for(const line of lines){
    const size=line.size??10;
    for(const text of blocks(line.text,font,size)){
      if(y<55){page=pdf.addPage([595,842]);y=790;}
      if(text)page.drawText(text,{x:49,y,size,font,color:size>=14?accent:ink,maxWidth:497});
      y-=size+5;
    }
    y-=line.space??0;
  }
  for(const [index,p] of pdf.getPages().entries()){
    p.drawLine({start:{x:49,y:35},end:{x:546,y:35},color:accent,thickness:.5});
    p.drawText(`${title} · ${index+1} / ${pdf.getPageCount()}`,{x:49,y:21,size:8,font,color:ink,maxWidth:497});
  }
  return new Uint8Array(await pdf.save());
}

export function invoicePdf(invoice:Invoice,items:InvoiceItem[],payment?:Payment) {
  const money=(amount:number)=>financeMoney(amount,invoice.currency);
  const title=payment?"Receipt "+payment.receipt_number:"Invoice "+invoice.invoice_number;
  return financePdf(title,invoice.issuer_name,[
    ...(payment?.sandbox?[{text:"Stripe sandbox receipt · No funds collected",size:11,space:10}]:[]),
    {text:title,size:21,space:7},
    {text:invoice.issuer_name,size:13},{text:invoice.issuer_address,space:4},
    ...(invoice.issuer_tax_number?[{text:`Tax registration: ${invoice.issuer_tax_number}`}]:[]),
    {text:`Issued ${invoice.issue_on} · Due ${invoice.due_on} · ${invoice.status}`},
    {text:`Bill to: ${invoice.recipient_name}\n${invoice.recipient_email}\nCase ${invoice.case_reference}`,space:12},
    ...items.map(item=>({text:`${item.position}. ${item.description}\n${item.quantity} × ${money(item.unit_minor)} · tax ${(item.tax_bps/100).toFixed(2)}% · total ${money(item.total_minor)}`,space:5})),
    {text:`Subtotal ${money(invoice.subtotal_minor)}\nTax ${money(invoice.tax_minor)}`,space:4},
    {text:`${payment?"Confirmed payment":"Invoice total"} ${money(invoice.total_minor)}`,size:15,space:8},
    ...(payment?[{text:`Invoice ${invoice.invoice_number}\nConfirmed ${payment.confirmed_at} UTC\nStripe reference: ${payment.provider_reference??payment.provider_session}`}] : []),
    ...(invoice.status==="Void"?[{text:"This invoice was voided. No payment is due."}]:[]),
  ]);
}

export function agreementPdf(version:AgreementVersion,evidence?:SignatureEvidence) {
  return financePdf(evidence?"Signed agreement · v"+version.version:"Agreement · v"+version.version,version.issuer_name,[
    {text:version.title,size:20,space:7},
    {text:`${version.issuer_name} · Version ${version.version} · Case ${version.case_reference}`,space:9},
    {text:"Terms and conditions",size:14},{text:version.terms,space:10},
    ...(version.undertakings?[{text:"Undertakings",size:14},{text:version.undertakings,space:9}]:[]),
    {text:`Version fingerprint: ${version.content_hash}`,size:8},
    ...(evidence?[{text:"Electronic signing record",size:14,space:5},
      {text:`Signer: ${evidence.signer_name} · ${evidence.signer_email}\nSigned at: ${evidence.responded_at} UTC\nConsent: ${evidence.consent_version}`},
      {text:electronicConsent},{text:`Session evidence: ${evidence.session_hash}`,size:8}] : []),
  ]);
}

export function financePdfResponse(data:Uint8Array,filename:string) {
  return new Response(new Uint8Array(data),{headers:{
    "Content-Type":"application/pdf","Content-Disposition":`attachment; filename="${filename}.pdf"`,
    "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox",
  }});
}
