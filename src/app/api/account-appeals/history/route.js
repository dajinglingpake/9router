import { authorizeAppealRequest, appealResponse, appealFailure } from "@/lib/accountAppeals/request";
import { listAppealHistory, getAppealHistory, updateAppealResult } from "@/lib/accountAppeals/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    await authorizeAppealRequest(request);
    const params = request.nextUrl.searchParams, connectionId = params.get("connectionId"), threadId = params.get("threadId");
    const offset = Math.max(0, Number.parseInt(params.get("offset"), 10) || 0);
    return appealResponse(threadId ? await getAppealHistory(connectionId, threadId) : await listAppealHistory(connectionId, offset));
  } catch (error) { return appealFailure(error); }
}

export async function PUT(request) {
  try {
    await authorizeAppealRequest(request, true);
    const input = await request.json();
    return appealResponse(await updateAppealResult(input.connectionId, input.threadId, input));
  } catch (error) { return appealFailure(error); }
}
