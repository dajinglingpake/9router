import { NextResponse } from "next/server";
import { getRequestErrors, clearRequestErrors } from "@/lib/db/repos/requestErrorsRepo.js";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request) {
  try {
    const filter = Object.fromEntries(new URL(request.url).searchParams);
    const [result, connections] = await Promise.all([getRequestErrors(filter), getProviderConnections()]);
    const labels = new Map(connections.map(item => [item.id, item.name || item.email || item.id.slice(0, 8)]));
    return NextResponse.json({ ...result, items: result.items.map(item => ({
      ...item, account: labels.get(item.connectionId) || item.connectionId || "—",
    })) }, { headers });
  } catch {
    return NextResponse.json({ error: "读取错误日志失败" }, { status: 500, headers });
  }
}

export async function DELETE(request) {
  try {
    const filter = await request.json();
    if (filter.confirmed !== true) return NextResponse.json({ error: "请确认清空日志" }, { status: 400, headers });
    return NextResponse.json(await clearRequestErrors(filter), { headers });
  } catch {
    return NextResponse.json({ error: "清空错误日志失败" }, { status: 400, headers });
  }
}
