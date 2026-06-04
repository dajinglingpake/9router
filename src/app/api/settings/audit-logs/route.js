import { NextResponse } from "next/server";
import { clearAuditLogs } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function DELETE(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await clearAuditLogs(body);
    return NextResponse.json({ success: true, ...result }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to clear audit logs" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
}
