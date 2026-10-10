import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { dismissAccountOverloadWarning, getAccountOverloadWarnings, getAccountOverloadDetails } from "@/lib/db/repos/accountOverloadWarningsRepo";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { id } = await params;
  if (!await getProviderConnectionById(id)) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }
  return NextResponse.json(await getAccountOverloadDetails(id));
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  if (!await getProviderConnectionById(id)) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }
  let eventId;
  try {
    ({ eventId } = await request.json());
    if (typeof eventId !== "string" || !/^[0-9a-f-]{36}$/.test(eventId)) throw new Error("Invalid warning event");
  } catch {
    return NextResponse.json({ error: "警告记录无效，请刷新后重试" }, { status: 400 });
  }
  await dismissAccountOverloadWarning(id, eventId);
  const warnings = await getAccountOverloadWarnings(id);
  return NextResponse.json({ overloadWarning: warnings[id] || null });
}
