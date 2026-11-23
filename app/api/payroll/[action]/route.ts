import {checkOrigin,currentActor,database,fail,handleError,needsStaffMfa,payload} from '@/lib/walshken/server';
import {requirePayrollFeature} from '@/lib/walshken/payroll-access';
import {payrollData,payrollDetail,payrollHolidayFacts} from '@/lib/walshken/payroll-data';
import {payrollAction} from '@/lib/walshken/payroll-actions';
import {payrollCsv,payslipPdf} from '@/lib/walshken/payroll-reports';
export const runtime='nodejs';export const maxDuration=300;
type Context={params:Promise<{action:string}>};
async function access(request:Request){const db=database(),actor=await currentActor(db,request);if(!actor)return fail(401,'Sign in to your staff workspace.');if(needsStaffMfa(actor))return fail(403,'Complete your authenticator setup first.');requirePayrollFeature(actor);return {db,actor};}
export async function GET(request:Request,{params}:Context){try{const {db,actor}=await access(request),{action}=await params,q=new URL(request.url).searchParams;if(action==='list')return await payrollData(db,actor,q);if(action==='detail')return await payrollDetail(db,actor,q.get('id')??'');if(action==='holiday-facts')return await payrollHolidayFacts(db,actor,q);if(action==='payslip')return await payslipPdf(db,actor,q.get('id')??'');if(action==='export')return await payrollCsv(db,actor,q);return fail(404,'Payroll endpoint unavailable.');}catch(e){return handleError(e);}}
export async function POST(request:Request,{params}:Context){try{checkOrigin(request);const {db,actor}=await access(request);return await payrollAction(db,actor,(await params).action,await payload(request));}catch(e){return handleError(e);}}
