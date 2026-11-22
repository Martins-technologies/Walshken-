import { createHash } from "node:crypto";
import { join } from "node:path";
import { createCanvas, loadImage, GlobalFonts, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import yauzl from "yauzl";
import { fail } from "./server";
import { documentLimits } from "./document-types";

GlobalFonts.registerFromPath(join(process.cwd(),"public/inter-latin.woff2"),"Walshken");
Object.assign(globalThis,{DOMMatrix,ImageData,Path2D});
const mimes:Record<string,string>={pdf:"application/pdf",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp"};
type Page={kind:"text";lines:string[];title:string}|{kind:"image";bytes:Buffer;title:string};
export type InspectedDocument={mime:string;pages:number;sha256:string;filename:string};
function cleanName(value:string){return value.replace(/[\/\\\u0000-\u001f\u007f]/g,"_").slice(0,150);}
async function inspectArchive(bytes:Buffer,extension:string){
 await new Promise<void>((resolve,reject)=>{
  yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
   if(error||!zip)return reject(Error("Invalid Office archive"));
   let count=0,total=0,main=false;const names=new Set<string>();
   const stop=(e:Error)=>{zip.close();reject(e);};
   zip.on("error",stop);zip.on("end",()=>main?resolve():reject(Error("Missing Office document")));
   zip.on("entry",entry=>{
    const name=entry.fileName;
    if(++count>documentLimits.zipEntries||(total+=entry.uncompressedSize)>documentLimits.expandedBytes||names.has(name)||name.includes("..")||name.startsWith("/")||entry.generalPurposeBitFlag&1||/vbaProject|embeddings\/|activeX\//i.test(name))return stop(Error("Unsafe or oversized Office archive"));
    names.add(name);if(name===(extension==="docx"?"word/document.xml":"xl/workbook.xml"))main=true;
    if(/\.(xml|rels)$/i.test(name))zip.openReadStream(entry,(e,stream)=>{
     if(e||!stream)return stop(Error("Unreadable Office content"));let text="";
     stream.on("data",chunk=>{text+=chunk.toString();if(text.length>documentLimits.expandedBytes){stream.destroy();stop(Error("Oversized Office content"));}});
     stream.on("error",stop);stream.on("end",()=>{
      if(/<!DOCTYPE|<!ENTITY|<externalLink\b|macroEnabled/i.test(text)||(/TargetMode\s*=\s*["']External["']/i.test(text)&&!(/relationships\/hyperlink/.test(text)&&!/<Relationship\b[^>]*Type=["'][^"']*\/(?:image|oleObject|attachedTemplate)["'][^>]*TargetMode=["']External/i.test(text))))return stop(Error("External or active Office content is not permitted"));
      zip.readEntry();
     });
    });else zip.readEntry();
   });zip.readEntry();
  });
 });
}
const wrap=(line:string,width=92)=>{const result:string[]=[];let value=line.replace(/\t/g,"    ");while(value.length>width){let at=value.lastIndexOf(" ",width);if(at<width/2)at=width;result.push(value.slice(0,at));value=value.slice(at).trimStart();}result.push(value);return result;};
async function officePages(bytes:Buffer,extension:string):Promise<Page[]>{
 const pages:Page[]=[];let lines:string[]=[],title=extension==="docx"?"Word document":"Workbook";
 const flush=()=>{if(lines.length){pages.push({kind:"text",lines,title});lines=[];}};
 const add=(text:string)=>{for(const line of text.split(/\r?\n/).flatMap(v=>wrap(v))){lines.push(line);if(lines.length===57)flush();}};
 if(extension==="docx"){
  const result=await mammoth.extractRawText({buffer:bytes});add(result.value);flush();
  // Include internal illustrations without fetching any remote references.
  const images:Buffer[]=[];
  await mammoth.convertToHtml({buffer:bytes},{externalFileAccess:false,convertImage:mammoth.images.imgElement(async image=>{const body=await image.read();if(body.length>documentLimits.bytes)throw Error("Illustration is too large");images.push(body);return {src:""};})});
  for(const [index,image]of images.entries()){await validImage(image);pages.push({kind:"image",bytes:image,title:`Document illustration ${index+1}`});}
 }else{
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  let cells=0;
  for(const sheet of workbook.worksheets){
   flush();title=sheet.name;add(`WORKSHEET: ${sheet.name}`);add("");
   sheet.eachRow((row,rowNumber)=>{const parts:string[]=[];row.eachCell((cell,column)=>{if(++cells>documentLimits.cells)throw Error("The workbook contains too many cells");
    let text=cell.text;if(cell.type===ExcelJS.ValueType.Formula){const value=cell.value as ExcelJS.CellFormulaValue;text=value.result==null?`=${value.formula} [not evaluated]`:String(value.result);}
    parts.push(`${sheet.getColumn(column).letter}: ${text}`);
   });add(`Row ${rowNumber}   ${parts.join("   |   ")}`);add("");});flush();
  }
 }
 flush();if(!pages.length)pages.push({kind:"text",lines:["This document has no visible text or images."],title});
 if(pages.length>documentLimits.pages)throw Error("The document exceeds the 200-page content preview limit");return pages;
}
async function validImage(bytes:Buffer){
 // Check bounded raster headers before native decoding. SVG/HTML and image bombs never reach a decoder.
 let width=0,height=0;
 if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"))){width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);}
 else if(bytes.length>12&&bytes.subarray(0,3).equals(Buffer.from("ffd8ff","hex"))){
  let offset=2;while(offset+4<bytes.length){if(bytes[offset++]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===217||marker===218)break;if(marker===1||marker>=208&&marker<=216)continue;
   const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;}offset+=length;
  }
 }else if(bytes.length>=30&&bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP"){
  const type=bytes.subarray(12,16).toString();
  if(type==="VP8X"){if(bytes[20]&2)throw Error("Use a still image instead of an animated WebP");width=bytes.readUIntLE(24,3)+1;height=bytes.readUIntLE(27,3)+1;}
  else if(type==="VP8L"&&bytes[20]===47){width=1+bytes[21]+((bytes[22]&63)<<8);height=1+(bytes[22]>>6)+(bytes[23]<<2)+((bytes[24]&15)<<10);}
  else if(type==="VP8 "){const marker=bytes.indexOf(Buffer.from("9d012a","hex"),20);if(marker>=0&&marker<64&&marker+7<=bytes.length){width=bytes.readUInt16LE(marker+3)&16383;height=bytes.readUInt16LE(marker+5)&16383;}}
 }
 if(width<1||height<1||width*height>24_000_000)throw Error("Choose a valid raster image up to 24 megapixels");
 const image=await loadImage(bytes);if(image.width!==width||image.height!==height)throw Error("Image dimensions are inconsistent");return image;
}
async function pdf(bytes:Buffer){
 const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs");
 // No worker URL from a request and no external document URLs.
 // @ts-expect-error The worker bundle has no declaration file.
 const worker=await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
 Object.assign(globalThis,{pdfjsWorker:worker});
 return pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true,disableFontFace:true,maxImageSize:16_000_000,
  standardFontDataUrl:join(process.cwd(),"node_modules/pdfjs-dist/standard_fonts/"),cMapUrl:join(process.cwd(),"node_modules/pdfjs-dist/cmaps/"),cMapPacked:true,
  wasmUrl:join(process.cwd(),"node_modules/pdfjs-dist/wasm/")}).promise;
}
export async function inspectDocument(filename:string,bytes:Buffer):Promise<InspectedDocument>{
 const name=cleanName(filename),extension=name.split(".").pop()?.toLowerCase()??"",mime=mimes[extension];
 if(!mime||!bytes.length||bytes.length>documentLimits.bytes)return fail(400,"Choose a PDF, DOCX, XLSX, PNG, JPEG or WebP file up to 3 MB.");
 let pages=1;
 try{
  if(extension==="pdf"){
   if(bytes.subarray(0,5).toString()!=="%PDF-")throw Error("Invalid PDF header");const doc=await pdf(bytes);try{pages=doc.numPages;if(pages>documentLimits.pages)throw Error("PDF exceeds 200 pages");await doc.getPage(1);}finally{await doc.loadingTask.destroy();}
  }else if(extension==="docx"||extension==="xlsx"){await inspectArchive(bytes,extension);pages=(await officePages(bytes,extension)).length;}
  else await validImage(bytes);
 }catch(error){fail(400,error instanceof Error&&/password/i.test(error.message)?"Remove the document password before uploading.":`This file cannot be safely previewed. ${error instanceof Error?error.message.slice(0,160):"Check the file format."}`);}
 return {mime,pages,sha256:createHash("sha256").update(bytes).digest("hex"),filename:name};
}
export async function renderDocumentPage(filename:string,bytes:Buffer,pageNumber:number,watermark:string){
 const extension=filename.split(".").pop()?.toLowerCase();let canvas=createCanvas(1200,1600),context=canvas.getContext("2d");
 context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);
 if(extension==="pdf"){
  const doc=await pdf(bytes);try{
   if(pageNumber>doc.numPages)return fail(404,"Preview page is unavailable.");const page=await doc.getPage(pageNumber),initial=page.getViewport({scale:1});
   const viewport=page.getViewport({scale:Math.min(1.7,1400/initial.width,1900/initial.height)});
   canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));context=canvas.getContext("2d");
   await page.render({canvas:canvas as never,canvasContext:context as never,viewport,background:"#fff"}).promise;
  }finally{await doc.loadingTask.destroy();}
 }else if(extension==="docx"||extension==="xlsx"){
  const pages=await officePages(bytes,extension),page=pages[pageNumber-1];if(!page)return fail(404,"Preview page is unavailable.");
  context.fillStyle="#13213c";context.font="bold 24px Walshken, sans-serif";context.fillText(page.title,65,62);context.fillStyle="#93a1b8";context.fillRect(65,83,1070,1);
  if(page.kind==="text"){context.font="17px Walshken, sans-serif";context.fillStyle="#1c2940";page.lines.forEach((line,i)=>context.fillText(line,65,120+i*24));}
  else {const image=await validImage(page.bytes),scale=Math.min(1070/image.width,1380/image.height,1);context.drawImage(image,(1200-image.width*scale)/2,110,image.width*scale,image.height*scale);}
 }else{
  if(pageNumber!==1)return fail(404,"Preview page is unavailable.");const image=await validImage(bytes),scale=Math.min(1400/image.width,1800/image.height,1);
  canvas=createCanvas(Math.max(300,Math.ceil(image.width*scale)),Math.max(150,Math.ceil(image.height*scale)));context=canvas.getContext("2d");context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,image.width*scale,image.height*scale);
 }
 if(watermark){
  context.save();context.globalAlpha=0.15;context.fillStyle="#17294c";context.font=`bold ${Math.max(14,Math.min(23,canvas.width/36))}px Walshken, sans-serif`;
  for(let y=80;y<canvas.height;y+=230){context.save();context.translate(12,y);context.rotate(-Math.PI/12);context.fillText(watermark,0,0);context.restore();}context.restore();
  context.fillStyle="#fff";context.fillRect(0,canvas.height-35,canvas.width,35);context.fillStyle="#32445f";context.font=`${Math.max(10,Math.min(13,canvas.width/70))}px Walshken, sans-serif`;context.fillText(watermark,10,canvas.height-12);
 }
 return canvas.toBuffer("image/jpeg",85);
}
