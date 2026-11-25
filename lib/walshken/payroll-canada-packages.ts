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

// CRA T4127, 124th edition, chapter 8. The published guide flags proposed
// changes. Keep the package versioned so later releases never rewrite 2026.
export const craJanuary2027 = 'https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jan/t4127-jan-payroll-deductions-formulas-computer-programs.html';
const brackets2027: Record<string, [number, string, number][]> = {
 Federal: [[0,"0.1400",0],[60044,"0.2050",3903],[120088,"0.2600",10508],[186157,"0.2900",16092],[265203,"0.3300",26701]],
 AB: [[0,"0.0800",0],[62424,"0.1000",1248],[157344,"0.1200",4395],[188813,"0.1300",6283],[251750,"0.1400",8801],[377625,"0.1500",12577]],
 BC: [[0,"0.0560",0],[50363,"0.0770",1058],[100728,"0.1050",3878],[115648,"0.1229",5948],[140430,"0.1470",9332],[190405,"0.1680",13331],[265545,"0.2050",23156]],
 MB: [[0,"0.1080",0],[47000,"0.1275",917],[100000,"0.1740",5567]],
 NB: [[0,"0.0940",0],[53693,"0.1400",2470],[107388,"0.1600",4618],[198902,"0.1950",11579]],
 NL: [[0,"0.0870",0],[46152,"0.1450",2677],[92303,"0.1580",3877],[164792,"0.1780",7173],[230710,"0.1980",11787],[294734,"0.2080",14734],[589469,"0.2130",17681],[1178938,"0.2180",23576]],
 NS: [[0,"0.0879",0],[32080,"0.1495",1976],[64160,"0.1667",3080],[100827,"0.1750",3917],[162624,"0.2100",9608]],
 NT: [[0,"0.0590",0],[54381,"0.0860",1468],[108765,"0.1220",5384],[176827,"0.1405",8655]],
 NU: [[0,"0.0400",0],[57252,"0.0700",1718],[114503,"0.0900",4008],[186156,"0.1150",8662]],
 ON: [[0,"0.0505",0],[55023,"0.0915",2256],[110049,"0.1116",4468],[150000,"0.1216",5968],[220000,"0.1316",8168]],
 PE: [[0,"0.0950",0],[33928,"0.1347",1347],[65820,"0.1660",3407],[106890,"0.1762",4497],[142520,"0.1900",6464],[200000,"0.2000",8464]],
 SK: [[0,"0.1050",0],[55950,"0.1250",1119],[159856,"0.1450",4316]],
 YT: [[0,"0.0640",0],[60044,"0.0900",1561],[120088,"0.1090",3843],[186157,"0.1280",7380],[500000,"0.1500",18380]],
};
const basic2027: Record<string, number> = {
 AB:23225, BC:13216, MB:15780, NB:14019, NL:15495, NS:12350,
 NT:18672, NU:20170, ON:13261, PE:15000, SK:21411, YT:16879,
};

export function canadaTaxPackages2027(): CanadaAlbertaParameters[] {
 // Revenu Québec's 2027 provincial withholding formula was still pending
 // when this package was verified. CRA values alone cannot supply it.
 return regions.filter(region => region.code !== 'QC').map(region => {
  const regional = structuredClone(region);
  regional.basic = basic2027[region.code];
  if (region.code === 'BC') regional.reduction = {amount:690,from:25570,through:44952,rate:'.0356'};
  if (region.code === 'ON') {
   regional.surtax = [{threshold:5940,rate:'.20'},{threshold:7603,rate:'.36'}];
   regional.dependantReduction = {basic:306,perDependant:566};
  }
  if (region.code === 'YT') {
   regional.basicMinimum=15214;
   regional.phaseFrom=186157;
   regional.phaseTo=265203;
  }
  return {
   ...structuredClone(canada2026), version:`CRA-T4127-2027-${region.code}-JAN-v1`,
   source:craJanuary2027, year:2027, validFrom:'2027-01-01', validThrough:'2027-12-31',
   ympe:76700, yampe:87400, cppRate:'.0575', cppBaseRate:'.0475', cppMax:'4209.00', cpp2Max:428,
   eiRate:'.0164', eiMax:'1161.12', bpaMax:16879, bpaMin:15214, cea:1540,
   bpaPhaseStart:186157, bpaPhaseEnd:265203, abSupplementThreshold:4993.92,
   abClaim:regional.basic, federalBrackets:brackets2027.Federal, provincialBrackets:brackets2027[region.code], region:regional,
  };
 });
}

export function maintainedCanadaTaxPackages() {
 return [...canadaTaxPackages2026(), ...canadaTaxPackages2027()];
}
