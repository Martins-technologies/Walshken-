export function formatAppointmentTime(starts:string,ends:string,zone:string,locale?:string) {
  const start = new Date(starts), end = new Date(ends);
  const format = new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short",timeZone:zone});
  return typeof format.formatRange==="function" ? format.formatRange(start,end) : `${format.format(start)} – ${format.format(end)}`;
}

export function browserAppointmentZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
