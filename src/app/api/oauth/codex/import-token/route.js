import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { extractCodexAccountInfo } from "@/lib/oauth/providers";
import { normalizeCodexSession } from "@/lib/oauth/codexSessionImport";
import { getCodexReloginTarget, reloginCodexConnection } from "@/lib/oauth/reloginCodex";

/**
 * POST /api/oauth/codex/import-token
 * Import a ChatGPT access token (created from chatgpt.com settings)
 * as a provider connection, bypassing OAuth refresh flow.
 *
 * Body: { accessToken: string, name?: string }, a Session object, or { session, name?, connectionId? }.
 */
export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    if (body?.connectionId !== undefined) await getCodexReloginTarget(body.connectionId);
    let input = body?.session ?? body;
    if (typeof input?.accessToken === "string" && input.accessToken.trim().startsWith("{")) input = input.accessToken;
    const normalized = normalizeCodexSession(input);
    const accessToken = normalized?.accessToken;
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (typeof accessToken !== "string" || !accessToken.trim()) {
      return NextResponse.json(
        { error: "Access token is required" },
        { status: 400 }
      );
    }

    const token = accessToken.trim();

    // Extract account info from the JWT (email, workspace, plan)
    let email = null;
    let providerSpecificData = { authMethod: "access_token" };

    // Try decoding as JWT to extract email + workspace
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const missingPadding = (4 - (base64.length % 4)) % 4;
        const padded = base64 + "=".repeat(missingPadding);
        const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));

        // Extract from OpenAI JWT structure
        const auth = payload["https://api.openai.com/auth"] || {};
        const profile = payload["https://api.openai.com/profile"] || {};
        email = profile.email || payload.email || payload.preferred_username || null;

        if (auth.chatgpt_account_id) {
          providerSpecificData.chatgptAccountId = auth.chatgpt_account_id;
        }
        if (auth.chatgpt_plan_type) {
          providerSpecificData.chatgptPlanType = auth.chatgpt_plan_type;
        }

        // Store expiry info from JWT if available
        if (payload.exp) {
          providerSpecificData.jwtExp = payload.exp;
        }
      }
    } catch {
      // Not a JWT or malformed — still allow import as raw token
    }

    // Also try extractCodexAccountInfo via id_token-style extraction
    // (the access token itself may contain the same claims)
    if (!email) {
      const info = extractCodexAccountInfo(token);
      if (info.email) email = info.email;
      if (info.chatgptAccountId) providerSpecificData.chatgptAccountId = info.chatgptAccountId;
      if (info.chatgptPlanType) providerSpecificData.chatgptPlanType = info.chatgptPlanType;
    }

    email = normalized.email || email;
    for (const key of ["chatgptAccountId", "chatgptPlanType"]) {
      if (typeof normalized.providerSpecificData?.[key] === "string") providerSpecificData[key] = normalized.providerSpecificData[key];
    }
    const connectionName = name || email || "ChatGPT Access Token";

    // Save to database as access_token authType (no refresh token)
    const connectionData = {
      provider: "codex",
      authType: "access_token",
      accessToken: token,
      name: connectionName,
      email: email,
      providerSpecificData,
      ...(normalized.chatgptSession ? { chatgptSession: normalized.chatgptSession } : {}),
      ...(normalized.expiresAt ? { expiresAt: normalized.expiresAt } : {}),
      testStatus: "active",
    };
    const connection = body?.connectionId !== undefined
      ? await reloginCodexConnection(body.connectionId, connectionData)
      : await createProviderConnection(connectionData);

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        name: connection.name,
        workspace: providerSpecificData.chatgptAccountId || null,
        plan: providerSpecificData.chatgptPlanType || null,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Codex 导入失败，请检查输入后重试。" }, { status: error.status || 500 });
  }
}
