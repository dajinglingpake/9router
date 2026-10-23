import { getOfficialStatus } from "@/lib/officialStatus.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getOfficialStatus(), { headers: { "Cache-Control": "no-store" } });
}
