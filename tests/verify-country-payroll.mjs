import assert from 'node:assert/strict';
import {D} from '../lib/walshken/payroll-money.ts';
import {nationalTaxPackages} from '../lib/walshken/payroll-national-packages.ts';
import {nationalAnnualTax,nationalPayroll} from '../lib/walshken/payroll-tax-national.ts';
import {canadaTaxPackages2026,canadaTaxPackages2027,maintainedCanadaTaxPackages} from '../lib/walshken/payroll-canada-packages.ts';
import {canadianAlbertaTax} from '../lib/walshken/payroll-tax-ca.ts';
import {defaultPayPolicy} from '../lib/walshken/payroll-access.ts';
import {zeroBalance} from '../lib/walshken/payroll-money.ts';
import {fiscalYear,remainingFiscalPeriods} from '../lib/walshken/payroll-fiscal.ts';
const pkg=(country,regime)=>nationalTaxPackages().find(p=>p.country===country&&p.regime===regime&&p.validFrom<='2026-11-01'&&p.validThrough>='2026-11-30');
const election=p=>({regime:p.regime,resident:true,ageBand:'Under 60',annualOtherIncome:'0',annualDeductions:'0',annualExemptIncome:'0',previousEmployerIncome:'0',previousEmployerTax:'0',basicPay:'25000',averageDailyWage:'1000',statutoryMinimum:'37000',contributions:p.contributions.map(r=>({code:r.code,applies:true,reason:'Independently verified statutory coverage evidence'})),professionalTax:{applies:false,monthlyAmount:'0',annualCeiling:'0',source:'',reason:'Not applicable under verified worksite policy'},reviewReference:'Signed payroll elections for test fixture'});
const n=p=>({payDate:'2026-11-30',startsOn:'2026-11-01',endsOn:'2026-11-30',periods:12,remainingPeriods:12,gross:5000000,taxable:5000000,regular:5000000,ytdTaxable:0,ytdTax:0,priorMonthly:{},priorAnnual:{},election:election(p)});
const india=pkg('IN','New'),old=pkg('IN','Old'),pakistan=pkg('PK','Salary');
assert.equal(nationalAnnualTax(new D(1275000),india,election(india)).tax.toFixed(2),'0.00');
assert.equal(nationalAnnualTax(new D(1300000),india,election(india)).tax.toFixed(2),'26000.00');
assert.equal(nationalAnnualTax(new D(1500000),india,election(india)).tax.toFixed(2),'97500.00');
assert.equal(nationalAnnualTax(new D(550000),old,election(old)).tax.toFixed(2),'0.00');
assert.equal(nationalAnnualTax(new D(7200000),pakistan,election(pakistan)).tax.toFixed(2),'1494000.00');
assert.equal(nationalAnnualTax(new D(1200000),pakistan,election(pakistan)).tax.toFixed(2),'6000.00');
const missingPan=nationalPayroll({...n(india),panStatus:'Missing'},india);assert.equal(missingPan.lines.find(l=>l.code==='IN_TAX').employee,875000);const below=nationalPayroll({...n(india),panStatus:'Inoperative',gross:2000000,taxable:2000000,regular:2000000},india);assert.equal(below.lines.find(l=>l.code==='IN_TAX').employee,0);
const result=nationalPayroll(n(india),india),value=code=>result.lines.find(r=>r.code===code);
assert.equal(value('EPF').employee,300000);assert.equal(value('EPS').employer,208300);assert.equal(value('EPF').employer,91700);assert.equal(value('ESI').employee,37500);assert.equal(value('ESI').employer,162500);
const first=nationalPayroll({...n(india),gross:2000000,taxable:2000000,regular:2000000,election:{...election(india),basicPay:'12500'}},india);
const prior=Object.fromEntries(first.contributions.map(r=>['2026-11:'+r.code,{basis:r.basis,employee:r.employee,employer:r.employer}]));
const second=nationalPayroll({...n(india),gross:2000000,taxable:2000000,regular:2000000,election:{...election(india),basicPay:'12500'},priorMonthly:prior},india);
for(const code of ['EPF','EPS','EDLI','EPF_ADMIN'])for(const side of ['employee','employer'])assert.equal(first.lines.find(r=>r.code===code)[side]+second.lines.find(r=>r.code===code)[side],value(code)[side],`${code} cumulative monthly rounding and ceiling ${side}`);
const capped=nationalPayroll({...n(india),priorMonthly:Object.fromEntries(result.contributions.map(r=>['2026-11:'+r.code,{basis:r.basis,employee:r.employee,employer:r.employer}]))},india);assert.equal(capped.lines.find(r=>r.code==='EPF').employee,0);
const epsExempt=nationalPayroll({...n(india),election:{...election(india),contributions:election(india).contributions.map(r=>r.code==='EPS'?{...r,applies:false}:r)}},india);assert.equal(epsExempt.lines.find(r=>r.code==='EPF').employer,300000);
assert.throws(()=>nationalPayroll({...n(india),election:{...election(india),averageDailyWage:'0'}},india),/positive assessed/);
assert.throws(()=>nationalPayroll({...n(india),election:{...election(india),contributions:[]}},india),/Explicitly assess/);
assert.throws(()=>nationalPayroll({...n(india),payDate:'2027-04-01'},india),/does not cover/);
assert.throws(()=>nationalAnnualTax(new D(1200000),pakistan,{...election(pakistan),annualOtherIncome:'400000'}),/seventy-five/);
assert.equal(fiscalYear('IN','2027-02-15').year,2027);assert.equal(fiscalYear('PK','2026-06-30').year,2026);assert.equal(remainingFiscalPeriods('IN','2026-11-30','Monthly'),5);
assert.equal(remainingFiscalPeriods('CA','2026-12-30','Weekly'),1,'A final weekly payment must not project a payment into the next tax year');
assert.equal(remainingFiscalPeriods('IN','2027-03-18','Biweekly'),1,'A 14-day payment after 31 March belongs to the next India fiscal year');
assert.equal(remainingFiscalPeriods('PK','2027-06-16','Biweekly'),2,'A scheduled payment exactly on 30 June remains in the Pakistan fiscal year');
const profile=defaultPayPolicy({country:'CA',jurisdiction:'CA-AB'}).taxProfile;
for(const ca of canadaTaxPackages2026()){
 const r=canadianAlbertaTax({payDate:ca.validFrom,currency:'CAD',periods:26,periodIndex:1,taxable:400000,pensionable:400000,insurable:400000,bonus:0,bonusPensionable:0,bonusInsurable:0,pretax:0,bonusPretax:0,lastRegular:0,ytd:zeroBalance(),profile},ca);
 assert(r.lines.every(l=>Number.isSafeInteger(l.employee)&&l.employee>=0));assert(r.lines.some(l=>l.code===ca.region.code));if(ca.region.code==='QC'){assert.equal(r.lines.find(l=>l.code==='QPP').employee,24352);assert.equal(r.lines.find(l=>l.code==='QPIP').employee,1720);}
}
const qc=canadaTaxPackages2026().find(p=>p.region.code==='QC');
const example=canadianAlbertaTax({payDate:'2026-10-01',currency:'CAD',periods:26,periodIndex:18,taxable:400000,pensionable:400000,insurable:400000,bonus:0,bonusPensionable:0,bonusInsurable:0,pretax:20000,bonusPretax:0,lastRegular:0,ytd:zeroBalance(),profile:{...profile,provincialClaim:'Custom',provincialClaimAmount:'21830',annualProvincialCredit:'975'}},qc);
assert.equal(example.lines.find(l=>l.code==='QC').employee,44451,'Revenu Québec TP-1015.F-V 2026 Appendix 1 regular provincial withholding');
console.log('PASS Canada 13 regional packages; India new/old tax and rebate boundaries; Pakistan fiscal slabs; contribution caps, rounding, EPS split, applicability validation and fiscal years');

const january=canadaTaxPackages2027();
assert.equal(new Set(january.map(p=>p.region.code)).size,12);
assert(!maintainedCanadaTaxPackages().some(p=>p.region.code==='QC'&&p.validThrough>='2027-01-01'));
const regular2027={payDate:'2027-01-08',currency:'CAD',periods:26,periodIndex:1,taxable:400000,pensionable:400000,insurable:400000,bonus:0,bonusPensionable:0,bonusInsurable:0,pretax:0,bonusPretax:0,lastRegular:0,ytd:zeroBalance(),profile};
for(const province of january){
 const computed=canadianAlbertaTax(regular2027,province);
 assert.equal(computed.lines.find(row=>row.code==='CPP').employee,22226);
 assert.equal(computed.lines.find(row=>row.code==='EI').employee,6560);
 assert(computed.lines.find(row=>row.code===province.region.code).employee>0);
 assert.throws(()=>canadianAlbertaTax({...regular2027,payDate:'2026-12-31'},province),/Rates are never rolled forward/);
}
assert.throws(()=>canadianAlbertaTax({...regular2027,ytd:{...zeroBalance(),qpp:100}},january[0]),/Québec transfer/);
console.log('PASS January 2027 Canadian packages, exact CPP and EI amounts, expiry and Québec transfer gates');
