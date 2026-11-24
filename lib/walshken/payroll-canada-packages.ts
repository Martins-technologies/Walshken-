import {canada2026,type CanadaAlbertaParameters} from './payroll-tax-ca';
import type {CanadaRegionSettings} from './payroll-tax-regions';
export const craJanuary=canada2026.source;
export const craJuly='https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/payroll-deductions-t4127-payroll-deductions-formulas/t4127-jul-123rd-edition-effective-july-1-2026/t4127-jul-payroll-deductions-formulas.html';
export const quebec2026='https://www.revenuquebec.ca/documents/en/formulaires/tp/TP-1015.F-V(2026-01).pdf';
const tables:Record<string,[number,string,number][]>={
 AB:canada2026.provincialBrackets,
 BC:[[0,'.0506',0],[50363,'.077',1330],[100728,'.105',4150],[115648,'.1229',6220],[140430,'.147',9604],[190405,'.168',13603],[265545,'.205',23428]],
 MB:[[0,'.108',0],[47000,'.1275',917],[100000,'.174',5567]],
 NB:[[0,'.094',0],[52333,'.14',2407],[104666,'.16',4501],[193861,'.195',11286]],
 NL:[[0,'.087',0],[44678,'.145',2591],[89354,'.158',3753],[159528,'.178',6943],[223340,'.198',11410],[285319,'.208',14263],[570638,'.213',17117],[1141275,'.218',22823]],
 NS:[[0,'.0879',0],[30995,'.1495',1909],[61991,'.1667',2976],[97417,'.175',3784],[157124,'.21',9283]],
 NT:[[0,'.059',0],[53003,'.086',1431],[106009,'.122',5247],[172346,'.1405',8436]],
 NU:[[0,'.04',0],[55801,'.07',1674],[111602,'.09',3906],[181439,'.115',8442]],
 ON:[[0,'.0505',0],[53891,'.0915',2210],[107785,'.1116',4376],[150000,'.1216',5876],[220000,'.1316',8076]],
 PE:[[0,'.095',0],[33928,'.1347',1347],[65820,'.166',3407],[106890,'.1762',4497],[142520,'.19',6464]],
 QC:[[0,'.14',0],[54345,'.19',2717],[108680,'.24',8151],[132245,'.2575',10465]],
 SK:[[0,'.105',0],[54532,'.125',1091],[155805,'.145',4207]],
 YT:[[0,'.064',0],[58523,'.09',1522],[117045,'.109',3745],[181440,'.128',7193],[500000,'.15',18193]],
};
const regions:CanadaRegionSettings[]=[
 {code:'AB',name:'Alberta',basic:22769},
 {code:'BC',name:'British Columbia',basic:13216,reduction:{amount:575,from:25570,through:41722,rate:'.0356'}},
 {code:'MB',name:'Manitoba',basic:15780,basicMinimum:0,phaseFrom:200000,phaseTo:400000},
 {code:'NB',name:'New Brunswick',basic:13664},
 {code:'NL',name:'Newfoundland and Labrador',basic:11188},
 {code:'NS',name:'Nova Scotia',basic:11932},
 {code:'NT',name:'Northwest Territories',basic:18198},
 {code:'NU',name:'Nunavut',basic:19659},
 {code:'ON',name:'Ontario',basic:12989,surtax:[{threshold:5818,rate:'.2'},{threshold:7446,rate:'.36'}],dependantReduction:{basic:300,perDependant:554},health:[{from:20000,base:0,rate:'.06',cap:300},{from:36000,base:300,rate:'.06',cap:450},{from:48000,base:450,rate:'.25',cap:600},{from:72000,base:600,rate:'.25',cap:750},{from:200000,base:750,rate:'.25',cap:900}]},
 {code:'PE',name:'Prince Edward Island',basic:15000},
 {code:'QC',name:'Quebec',basic:18952,pensionRate:'.063',pensionBaseRate:'.053',pensionMax:'4479.30',eiRate:'.013',eiMax:'895.70',qpRate:'.0043',qpEmployerRate:'.00602',qpMax:'442.90',workersRate:'.06',workersMaximum:1450},
 {code:'SK',name:'Saskatchewan',basic:20381},
 {code:'YT',name:'Yukon',basic:16452,basicMinimum:14829,phaseFrom:181440,phaseTo:258482,employmentCredit:true},
];
export function canadaTaxPackages2026():CanadaAlbertaParameters[]{
 const versions:CanadaAlbertaParameters[]=[];
 for(const region of regions){
  const base:CanadaAlbertaParameters={...structuredClone(canada2026),version:`CRA-RQ-2026-${region.code}-JAN-v1`,abClaim:region.basic,provincialBrackets:tables[region.code],region,
   ...(region.code==='QC'?{cppRate:region.pensionRate!,cppBaseRate:region.pensionBaseRate!,cppMax:region.pensionMax!,eiRate:region.eiRate!,eiMax:region.eiMax!,bonusFlatRate:'.10',source:quebec2026}:{}),
  };
  if(['BC','NL','PE'].includes(region.code)){
   base.validThrough='2026-06-30';versions.push(base);
   const july=structuredClone(base);july.validFrom='2026-07-01';july.validThrough='2026-12-31';july.version=`CRA-2026-${region.code}-JUL-v1`;july.source=craJuly;
   if(region.code==='BC'){july.provincialBrackets=[[0,'.0614',0],[50363,'.077',786],[100728,'.105',3606],[115648,'.1229',5676],[140430,'.147',9061],[190405,'.168',13059],[265545,'.205',22884]];july.region!.reduction={amount:805,from:25570,through:44952,rate:'.0356'};}
   if(region.code==='NL'){july.region!.basic=15000;july.abClaim=15000;}
   if(region.code==='PE')july.provincialBrackets.push([200000,'.21',10464]);
   versions.push(july);
  }else versions.push(base);
 }
 return versions;
}
