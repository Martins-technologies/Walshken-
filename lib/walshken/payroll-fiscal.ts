export function fiscalYear(country:string,day:string){
 const y=Number(day.slice(0,4)),startMonth=country==='IN'?4:country==='PK'?7:1,m=Number(day.slice(5,7)),startYear=startMonth===1?y:m>=startMonth?y:y-1;
 const start=`${startYear}-${String(startMonth).padStart(2,'0')}-01`,end=new Date(Date.UTC(startYear+1,startMonth-1,0)).toISOString().slice(0,10);
 return {year:startMonth===1?startYear:startYear+1,start,end};
}
export function remainingFiscalPeriods(country:string,payDate:string,frequency:string){
 const f=fiscalYear(country,payDate),month=Number(payDate.slice(5,7)),endMonth=Number(f.end.slice(5,7)),monthCount=(endMonth-month+12)%12;
 // Include this payment and only subsequent scheduled payments that still fall
 // inside the fiscal year. Rounding up invents a payment beyond the year end.
 return frequency==='Monthly'?monthCount+1:frequency==='Semimonthly'?monthCount*2+(Number(payDate.slice(8))<=15?2:1):Math.max(1,Math.floor((Date.parse(f.end+'T12:00Z')-Date.parse(payDate+'T12:00Z'))/86400000/(frequency==='Weekly'?7:14))+1);
}
