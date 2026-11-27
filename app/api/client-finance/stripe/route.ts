import {clientPortalEnabled} from "@/lib/walshken/client-feature";
import {applyCheckoutWebhook} from "@/lib/walshken/client-finance-payments";
import {database,fail,handleError,json} from "@/lib/walshken/server";

export const runtime="nodejs";

export async function POST(request:Request) {
  try{
    if(!clientPortalEnabled())return fail(404,"Client payments are unavailable.");
    return json(await applyCheckoutWebhook(database(),request));
  }catch(error){return handleError(error);}
}
