export function employerSchemeCodes(country:string,jurisdictions:string[]){
 const codes=country==='CA'?['CPP','EI','WCB']:country==='IN'?['EPF','EPS','EDLI','EPF_ADMIN','ESI','PROFESSIONAL_TAX','LABOUR_WELFARE']:['EOBI','PROVINCIAL_SOCIAL_SECURITY','PROFESSIONAL_TAX'];
 if(country==='CA'){if(jurisdictions.includes('CA-QC'))codes.push('QPP','QPIP','HSF','LABOUR_STANDARDS','WSDRF');if(jurisdictions.some(j=>['CA-ON','CA-BC','CA-MB','CA-NL'].includes(j)))codes.push('EMPLOYER_HEALTH_TAX');if(jurisdictions.some(j=>['CA-NT','CA-NU'].includes(j)))codes.push('TERRITORIAL_PAYROLL_TAX');}return codes;
}
export const nativeEmployerCodes:Record<string,string[]>={CA:['CPP','EI','QPP','QPIP'],IN:['EPF','EPS','EDLI','EPF_ADMIN','ESI','PROFESSIONAL_TAX'],PK:['EOBI']};
