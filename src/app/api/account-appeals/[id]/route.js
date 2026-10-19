import { appealFrame, appealAction } from "@/lib/accountAppeals/sessions";
import { appealOwner, appealResponse, appealFailure } from "@/lib/accountAppeals/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request, { params }) {
  try {
    const { owner } = await appealOwner(request);
    return appealResponse(await appealFrame((await params).id, owner, request.nextUrl.searchParams.get("frame") !== "0"));
  } catch (error) { return appealFailure(error); }
}
export async function POST(request, { params }) {
  try {
    const { owner } = await appealOwner(request, true);
    return appealResponse(await appealAction((await params).id, owner, await request.json()));
  } catch (error) { return appealFailure(error); }
}
