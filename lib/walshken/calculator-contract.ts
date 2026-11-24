export const calculatorContract={
 contractVersion:1,
 health:{method:'GET',authorization:'Bearer API_KEY',response:{protocol:'walshken-payroll-v1',protocols:['walshken-payroll-v1','walshken-holiday-v1'],jurisdictions:'Explicit supported jurisdiction codes',taxYears:'Explicit supported year numbers'}},
 calculation:{method:'POST',request:['protocol','requestId','inputHash','sentAt','input'],response:['protocol','requestId','inputHash','validated:true','result'],signature:'x-payroll-signature: hex HMAC SHA256 of the exact response bytes using the response signing secret'},
 payrollResultType:'TaxResult in lib/walshken/payroll-types.ts',holidayResultType:'HolidayFacts with reference in lib/walshken/holiday-types.ts',
 requirements:['Preserve the request protocol, requestId and inputHash','Calculate using the requested effective jurisdiction rule version','Return exact integer minor-unit amounts','Never invent missing history, eligibility or rates','Return explicit QPP/QPIP lines for Quebec payroll','Calculate holiday entitlement before payment allocation; Walshken prevents duplicate allocation','Reject unsupported worker classifications or calculation years']
};
