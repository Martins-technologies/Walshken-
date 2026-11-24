import {D,money} from './payroll-money';
import type {PayPolicy} from './payroll-types';
export type CanadaRegionSettings={
 code:string;name:string;basic:number;basicMinimum?:number;phaseFrom?:number;phaseTo?:number;
 pensionRate?:string;pensionBaseRate?:string;pensionMax?:string;eiRate?:string;eiMax?:string;
 reduction?:{amount:number;from:number;through:number;rate:string};
 surtax?:{threshold:number;rate:string}[];
 health?:{from:number;base:number;rate:string;cap:number}[];
 dependantReduction?:{basic:number;perDependant:number};employmentCredit?:boolean;
 qpRate?:string;qpEmployerRate?:string;qpMax?:string;workersRate?:string;workersMaximum?:number;
};
type Decimal=InstanceType<typeof D>;
const positive=(v:Decimal)=>D.max(0,v);
export function provincialAnnual(A:Decimal,credits:{cpp:Decimal;ei:Decimal},gross:Decimal,profile:PayPolicy['taxProfile'],basicFederal:Decimal,table:[number,string,number][],settings:CanadaRegionSettings){
 const s=settings,native=profile.native??{};
 let basic=new D(s.basic);
 if(s.phaseFrom!==undefined&&s.phaseTo!==undefined)basic=basic.sub(D.min(basic.sub(s.basicMinimum??0),positive(A.sub(s.phaseFrom)).mul(basic.sub(s.basicMinimum??0)).div(s.phaseTo-s.phaseFrom)));
 if(s.code==='YT')basic=basicFederal;
 const claim=profile.provincialClaim==='None'?new D(0):profile.provincialClaim==='Custom'?new D(profile.provincialClaimAmount):basic;
 const annual=s.code==='QC'?positive(A.sub(D.min(gross.mul(s.workersRate??'.06'),s.workersMaximum??1450)).sub(String(native.quebecAnnualDeduction??'0'))):A;
 const band=[...table].reverse().find(row=>annual.gte(row[0]))!;
 let tax=positive(annual.mul(band[1]).sub(band[2]).sub((s.code==='QC'?claim:claim.add(credits.cpp).add(credits.ei)).mul(table[0][1])).sub(profile.annualProvincialCredit));
 if(s.employmentCredit)tax=positive(tax.sub(D.min(1501,gross).mul(table[0][1])));
 if(s.code==='AB')tax=positive(tax.sub(positive(claim.add(credits.cpp).add(credits.ei).mul(table[0][1]).sub(4896)).mul('.25')));
 const surtax=(s.surtax??[]).reduce((total,row)=>total.add(positive(tax.sub(row.threshold)).mul(row.rate)),new D(0));
 tax=tax.add(surtax);
 if(s.reduction&&A.lte(s.reduction.through))tax=positive(tax.sub(positive(new D(s.reduction.amount).sub(positive(A.sub(s.reduction.from)).mul(s.reduction.rate)))));
 if(s.dependantReduction){const deps=Number(native.ontarioEligibleDependants??0),reduction=positive(new D(s.dependantReduction.basic).add(new D(s.dependantReduction.perDependant).mul(deps)).mul(2).sub(tax));tax=positive(tax.sub(D.min(tax,reduction)));}
 const health=[...(s.health??[])].reverse().find(b=>A.gt(b.from));
 if(health)tax=tax.add(D.min(health.cap,new D(health.base).add(A.sub(health.from).mul(health.rate))));
 if(s.code==='QC')tax=positive(tax.add(new D(String(native.quebecAdditionalTax??'0'))));
 return tax.toDecimalPlaces(2);
}
