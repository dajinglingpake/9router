import { NextResponse } from "next/server";
import { getClientIpAliases, setClientIpAlias, deleteClientIpAlias } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

function validateAlias(alias) {
  if (alias !== undefined && typeof alias !== "string") return "Alias must be a string";
  if (typeof alias === "string" && alias.trim().length > 80) return "Alias must be 80 characters or fewer";
  return null;
}

export async function GET() {
  try {
    const aliases = await getClientIpAliases();
    return NextResponse.json({ aliases });
  } catch (error) {
    console.error("[API] Failed to get client IP aliases:", error);
    return NextResponse.json({ error: "Failed to fetch client IP aliases" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const ip = typeof body?.ip === "string" ? body.ip.trim() : "";
    const alias = typeof body?.alias === "string" ? body.alias.trim() : "";
    const aliasError = validateAlias(alias);

    if (!ip) return NextResponse.json({ error: "Client IP is required" }, { status: 400 });
    if (aliasError) return NextResponse.json({ error: aliasError }, { status: 400 });

    const saved = await setClientIpAlias(ip, alias);
    return NextResponse.json(saved);
  } catch (error) {
    console.error("[API] Failed to save client IP alias:", error);
    return NextResponse.json({ error: "Failed to save client IP alias" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const ip = searchParams.get("ip")?.trim();
    if (!ip) return NextResponse.json({ error: "Client IP is required" }, { status: 400 });
    const deleted = await deleteClientIpAlias(ip);
    return NextResponse.json(deleted);
  } catch (error) {
    console.error("[API] Failed to delete client IP alias:", error);
    return NextResponse.json({ error: "Failed to delete client IP alias" }, { status: 500 });
  }
}
