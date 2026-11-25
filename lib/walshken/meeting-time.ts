function calendarParts(instant:Date,zone:string) {
  return new Intl.DateTimeFormat("en-CA",{
    year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:zone,hourCycle:"h23",
  }).formatToParts(instant);
}
export function meetingLocalStamp(value:string|Date,zone:string) {
  const parts=new Map(calendarParts(new Date(value),zone).map(part=>[part.type,part.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}T${parts.get("hour")}:${parts.get("minute")}`;
}
export function meetingLocalCandidates(input:string,zone:string) {
  const nominal=Date.parse(input+"Z");
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)||!Number.isFinite(nominal)||new Date(nominal).toISOString().slice(0,16)!==input)return [];
  const offsets=new Set<number>();
  for(const hours of [-36,-12,0,12,36]){
    const sample=nominal+hours*3_600_000;
    offsets.add(Date.parse(meetingLocalStamp(new Date(sample),zone)+"Z")-sample);
  }
  return [...offsets].map(offset=>new Date(nominal-offset))
    .filter(guess=>meetingLocalStamp(guess,zone)===input).map(guess=>guess.toISOString()).sort();
}
