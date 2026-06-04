import { NextResponse } from "next/server";
import { claimApiKeyByName, findInvalidAllowedIps } from "@/lib/localDb";
import { extractClientIp } from "@/sse/utils/clientIp";

export const dynamic = "force-dynamic";

function normalizeUsername(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

function validateUsername(username) {
  if (!username) return "Username is required";
  if (username.length > 64) return "Username must be 64 characters or fewer";
  if (/[\u0000-\u001f\u007f]/.test(username)) return "Username contains invalid characters";
  return "";
}

function buildKeyResponse(apiKey) {
  return NextResponse.json({
    username: apiKey.name,
    apiKey: apiKey.key,
    id: apiKey.id,
    claimedAt: apiKey.claimedAt,
    allowedIps: apiKey.allowedIps,
  });
}

async function claimByUsername(username, clientIp, allowedIps) {
  const normalizedUsername = normalizeUsername(username);
  const error = validateUsername(normalizedUsername);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const invalidAllowedIps = findInvalidAllowedIps(allowedIps);
  if (invalidAllowedIps.length) {
    return NextResponse.json({ error: "Allowed IPs contain invalid addresses", invalidAllowedIps }, { status: 400 });
  }

  const result = await claimApiKeyByName(normalizedUsername, clientIp, allowedIps);
  if (result.status === "invalid_ip") {
    return NextResponse.json({ error: "Unable to determine a valid client IP" }, { status: 400 });
  }
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Username does not have an API key", username: normalizedUsername }, { status: 404 });
  }
  if (result.status === "disabled") {
    return NextResponse.json({ error: "API key is disabled", username: result.apiKey.name }, { status: 403 });
  }
  if (result.status === "already_claimed") {
    return NextResponse.json({ error: "API key has already been claimed", username: result.apiKey.name, claimedAt: result.apiKey.claimedAt }, { status: 409 });
  }

  return buildKeyResponse(result.apiKey);
}

export async function GET() {
  return NextResponse.json(
    { error: "Use POST /api/keys/claim or open /claim-key to claim an API key" },
    { status: 405 }
  );
}

export async function POST(request) {
  try {
    const clientIp = extractClientIp(request);
    const contentType = request.headers.get("content-type") || "";
    let username = "";
    let allowedIps = [];
    if (contentType.includes("application/json")) {
      const body = await request.json().catch(() => ({}));
      username = normalizeUsername(body.username);
      allowedIps = body.allowedIps ?? [];
    } else {
      username = normalizeUsername(await request.text().catch(() => ""));
    }
    return await claimByUsername(username, clientIp, allowedIps);
  } catch (error) {
    console.log("Error claiming key:", error);
    return NextResponse.json({ error: "Failed to claim API key" }, { status: 500 });
  }
}
