import { liveKitWebhook } from "@/lib/walshken/meetings";
import { database, handleError } from "@/lib/walshken/server";
export const runtime="nodejs";
export const maxDuration=60;
export async function POST(request:Request){try{return await liveKitWebhook(database(),request);}catch(error){return handleError(error);}}
