import {createHash} from "node:crypto";

type PrivateEvent = {
  identity:string;
  sequence:number;
  startsAt:string;
  endsAt:string;
  title:string;
  description:string;
  filename:"walshken-meeting.ics"|"walshken-consultation.ics";
};

const stamp=(value:string)=>new Date(value).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
const escapeText=(value:string)=>value.replace(/\\/g,"\\\\").replace(/\r\n|[\r\n]/g,"\\n").replace(/[,;]/g,match=>"\\"+match).replace(/[\x00-\x08\x0B-\x1F\x7F]/g,"");

function foldLine(line:string) {
  const lines:string[]=[];
  let current="", length=0;
  for(const symbol of line){
    const bytes=Buffer.byteLength(symbol);
    if(length+bytes>75){lines.push(current);current=" ";length=1;}
    current+=symbol;
    length+=bytes;
  }
  return [...lines,current].join("\r\n");
}

export function privateCalendarFile(event:PrivateEvent) {
  const uid=createHash("sha256").update(event.identity).digest("hex");
  const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Walshken//Private Calendar//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH","BEGIN:VEVENT",
    `UID:${uid}@walshken`, `DTSTAMP:${stamp(new Date().toISOString())}`, `SEQUENCE:${event.sequence}`, `DTSTART:${stamp(event.startsAt)}`, `DTEND:${stamp(event.endsAt)}`,
    `SUMMARY:${escapeText(event.title)}`, `DESCRIPTION:${escapeText(event.description)}`, "STATUS:CONFIRMED", "CLASS:PRIVATE", "END:VEVENT", "END:VCALENDAR"];
  return new Response(lines.map(foldLine).join("\r\n")+"\r\n",{headers:{"Content-Type":"text/calendar; charset=utf-8", "Content-Disposition":`attachment; filename="${event.filename}"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}
