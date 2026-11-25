import assert from 'node:assert/strict';
import {D} from '../lib/walshken/payroll-money.ts';
import {nationalTaxPackages} from '../lib/walshken/payroll-national-packages.ts';
import {nationalAnnualTax,nationalPayroll} from '../lib/walshken/payroll-tax-national.ts';
import {canadaTaxPackages2026} from '../lib/walshken/payroll-canada-packages.ts';
import {canadianAlbertaTax} from '../lib/walshken/payroll-tax-ca.ts';
import {defaultPayPolicy} from '../lib/walshken/payroll-access.ts';
import {zeroBalance,currencyDigits} from '../lib/walshken/payroll-money.ts';
import {fiscalYear,remainingFiscalPeriods} from '../lib/walshken/payroll-fiscal.ts';
import {validateEmploymentSettings} from '../lib/walshken/employment-settings.ts';
const pkg=(country,regime)=>nationalTaxPackages().find(p=>p.country===country&&p.regime===regime&&p.validFrom<='2026-11-01'&&p.validThrough>='2026-11-30');
const election=p=>({regime:p.regime,resident:true,ageBand:'Under 60',annualOtherIncome:'0',annualDeductions:'0',annualExemptIncome:'0',previousEmployerIncome:'0',previousEmployerTax:'0',basicPay:'25000',averageDailyWage:'1000',statutoryMinimum:'37000',contributions:p.contributions.map(r=>({code:r.code,applies:true,reason:'Independently verified statutory coverage evidence'})),professionalTax:{applies:false,monthlyAmount:'0',annualCeiling:'0',source:'',reason:'Not applicable under verified worksite policy'},reviewReference:'Signed payroll elections for test fixture'});
const n=p=>({payDate:'2026-11-30',startsOn:'2026-11-01',endsOn:'2026-11-30',periods:12,remainingPeriods:12,gross:5000000,taxable:5000000,regular:5000000,ytdTaxable:0,ytdTax:0,priorMonthly:{},priorAnnual:{},election:election(p)});
const india=pkg('IN','New'),old=pkg('IN','Old'),pakistan=pkg('PK','Salary');
for(const currency of ['CAD','INR','PKR'])assert.equal(currencyDigits(currency),2,currency+' payroll money must use the same minor-unit precision as the maintained tax and contribution engines');
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

// Configured company rates are separate from the unchanged reference packages.
const governmentCanada=JSON.stringify(canadaTaxPackages2026()),governmentNational=JSON.stringify(nationalTaxPackages());
for(const original of canadaTaxPackages2026()){
 const raw=structuredClone(original);
 Object.assign(raw,{companyConfigured:true,cppRate:'0',cppBaseRate:'0',cppMax:'0',cpp2Rate:'0',cpp2Max:0,eiRate:'0',eiMax:'0',eiEmployerMultiplier:'0',bonusFlatRate:'0'});
 raw.federalBrackets=raw.federalBrackets.map(([from])=>[from,'0',0]);
 raw.provincialBrackets=raw.provincialBrackets.map(([from])=>[from,'0',0]);
 raw.region={...raw.region,qpRate:'0',qpEmployerRate:'0',qpMax:'0',workersRate:'0',workersMaximum:0,
  health:raw.region.health?.map(row=>({...row,base:0,rate:'0',cap:0})),surtax:raw.region.surtax?.map(row=>({...row,rate:'0'}))};
 const selected=validateEmploymentSettings('Canada payroll',raw);
 const zero=canadianAlbertaTax({payDate:selected.validFrom,currency:'CAD',periods:26,periodIndex:1,taxable:500000,pensionable:500000,insurable:500000,bonus:100000,bonusPensionable:100000,bonusInsurable:100000,pretax:0,bonusPretax:0,lastRegular:400000,ytd:zeroBalance(),profile},selected);
 assert(zero.lines.every(line=>line.employee===0&&line.employer===0),original.region.code+' explicit zero tax/contribution rates must not fall back or produce 0/0');
 assert.equal(zero.bonusEnhanced,0);
}
const independentQpip=structuredClone(qc);independentQpip.companyConfigured=true;
Object.assign(independentQpip.region,{qpRate:'0',qpMax:'0',qpEmployerRate:'.00602',qpInsurableMax:'100000'});
const selectedQpip=validateEmploymentSettings('Canada payroll',independentQpip);
const qpInput={payDate:'2026-10-01',currency:'CAD',periods:26,periodIndex:18,taxable:400000,pensionable:400000,insurable:400000,bonus:0,bonusPensionable:0,bonusInsurable:0,pretax:0,bonusPretax:0,lastRegular:0,ytd:zeroBalance(),profile};
let qpLine=canadianAlbertaTax(qpInput,selectedQpip).lines.find(line=>line.code==='QPIP');
assert.deepEqual([qpLine.employee,qpLine.employer],[0,2408],'An explicit zero employee rate must not erase a separately configured employer contribution');
qpLine=canadianAlbertaTax({...qpInput,ytd:{...zeroBalance(),insurable:9990000}},selectedQpip).lines.find(line=>line.code==='QPIP');
assert.deepEqual([qpLine.employee,qpLine.employer],[0,60],'The independent employer contribution honors the selected remaining annual insurable ceiling');
const zeroCanadianCaps=structuredClone(qc);zeroCanadianCaps.companyConfigured=true;
Object.assign(zeroCanadianCaps,{cppMax:'0',cpp2Max:0,eiMax:'0'});zeroCanadianCaps.region.qpMax='0';
const cappedCanadian=canadianAlbertaTax(qpInput,validateEmploymentSettings('Canada payroll',zeroCanadianCaps));
for(const code of ['QPP','QPP2','EI','QPIP']){
 const line=cappedCanadian.lines.find(row=>row.code===code);
 assert.deepEqual([line.employee,line.employer],[0,0],code+' zero contribution maximum remains a real zero cap even when rates are positive');
}
const uncappedIndia=structuredClone(india);uncappedIndia.companyConfigured=true;
const uncappedFund=uncappedIndia.contributions.find(row=>row.code==='EPF');Object.assign(uncappedFund,{monthlyCeiling:'0',annualCeiling:'0'});
const uncappedResult=nationalPayroll({...n(uncappedIndia),gross:10000000,taxable:10000000,regular:10000000,election:{...election(uncappedIndia),basicPay:'100000'}},validateEmploymentSettings('India payroll',uncappedIndia));
assert.equal(uncappedResult.lines.find(row=>row.code==='EPF').employee,1200000,'A national contribution wage ceiling of zero retains its existing uncapped meaning; a zero rate is how contributions are set to zero');
for(const original of [india,old,pakistan]){
 const raw=structuredClone(original);
 Object.assign(raw,{companyConfigured:true,missingPanRate:'0',standardDeduction:'0',cess:'0',rebate:{threshold:'0',maximum:'0',marginalRelief:false}});
 raw.slabs=raw.slabs.map(row=>({...row,rate:'0',fixed:'0'}));
 raw.surcharge=raw.surcharge.map(row=>({...row,rate:'0'}));
 raw.contributions=raw.contributions.map(row=>({...row,employeeRate:'0',employerRate:'0',...(row.employerTotalRate!==undefined?{employerTotalRate:'0'}:{})}));
 const selected=validateEmploymentSettings(original.country==='IN'?'India payroll':'Pakistan payroll',raw);
 const input={...n(selected),panStatus:'Missing',election:{...election(selected),ageBand:'80 or more'}};
 const zero=nationalPayroll(input,selected);
 assert(zero.lines.every(line=>line.employee===0&&line.employer===0),original.country+' '+original.regime+' selected zeros must override reference slabs, contributions and missing-PAN rate');
}
const higherIndia=structuredClone(india);higherIndia.companyConfigured=true;
for(const optional of ['employerTotalRate','employeeExemptDailyBelow']){
 const invalid=structuredClone(india);invalid.companyConfigured=true;invalid.contributions.find(row=>row.code==='EPF')[optional]=0;
 assert.throws(()=>validateEmploymentSettings('India payroll',invalid),/Enter |Invalid |exact decimal/i,optional+' numeric JSON zero must be rejected explicitly instead of silently dropping a configured contribution value');
}
Object.assign(higherIndia.contributions.find(row=>row.code==='EPF'),{employeeRate:'.25',employerRate:'.1667',employerTotalRate:'.25'});
const higherIndiaResult=nationalPayroll(n(higherIndia),validateEmploymentSettings('India payroll',higherIndia));
assert.equal(higherIndiaResult.lines.find(row=>row.code==='EPF').employee,625000);
assert.equal(higherIndiaResult.lines.find(row=>row.code==='EPF').employer,416700);
const higherPakistan=structuredClone(pakistan);higherPakistan.companyConfigured=true;
Object.assign(higherPakistan.contributions.find(row=>row.code==='EOBI'),{employeeRate:'.02',employerRate:'.07'});
const higherPakistanResult=nationalPayroll(n(higherPakistan),validateEmploymentSettings('Pakistan payroll',higherPakistan));
assert.equal(higherPakistanResult.lines.find(row=>row.code==='EOBI').employee,74000);
assert.equal(higherPakistanResult.lines.find(row=>row.code==='EOBI').employer,259000);
assert.equal(JSON.stringify(canadaTaxPackages2026()),governmentCanada,'Editing company rates must not mutate the government reference packages');
assert.equal(JSON.stringify(nationalTaxPackages()),governmentNational,'National suggestions remain intact after company calculations');
console.log('PASS selected zero rates across all Canadian tax regions, India and Pakistan; custom higher contributions; unchanged government reference packages');
