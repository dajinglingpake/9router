import { startAppeal } from "@/lib/accountAppeals/sessions";
import { appealOwner, appealResponse, appealFailure } from "@/lib/accountAppeals/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request) {
  try {
    const { owner, cookie } = await appealOwner(request, true, true);
    const input = await request.json();
    return appealResponse(await startAppeal(input.connectionId, owner, input.requestId), 202, cookie);
  } catch (error) { return appealFailure(error); }
}
