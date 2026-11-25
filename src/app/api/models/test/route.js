import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";
import { getModelTestContext, getProviderModelPreferences, getTestedModelTarget } from "@/lib/modelTests";
import { getModelTests, saveModelTest, saveModelTestPreferences } from "@/lib/db/repos/modelTestsRepo.js";
import { FREE_MODEL_FILTER_PROVIDERS, MODEL_TEST_PROVIDERS } from "@/shared/utils/modelTests";
import { safeDiagnosticMessage } from "open-sse/utils/upstreamDiagnostics.js";

const NO_TEST_CONTEXT = "请启用供应商账号，并确认存在允许本机调用的通用 API Key。";
const headers = { "Cache-Control": "no-store" };

export async function GET(request) {
  const provider = new URL(request.url).searchParams.get("provider");
  if (!MODEL_TEST_PROVIDERS.includes(provider)) return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  try {
    const [context, byProvider] = await Promise.all([getModelTestContext(provider), getProviderModelPreferences()]);
    const preferences = byProvider.get(provider);
    if (!context) return NextResponse.json({ results: {}, canTest: false, warning: NO_TEST_CONTEXT, preferences }, { headers });
    const results = (await getModelTests([context.scope])).get(context.scope);
    return NextResponse.json({ results: Object.fromEntries(results || []), canTest: true, preferences }, { headers });
  } catch {
    return NextResponse.json({ error: "无法读取模型测试记录。" }, { status: 500, headers });
  }
}

export async function PATCH(request) {
  const body = await request.json().catch(() => null);
  const { provider, ...changes } = body || {};
  const entries = Object.entries(changes);
  if (!MODEL_TEST_PROVIDERS.includes(provider) || !entries.length || entries.some(([key, value]) =>
    typeof value !== "boolean" || (key !== "hideFailedModels" && !(FREE_MODEL_FILTER_PROVIDERS.includes(provider) && key === "freeOnly")))) {
    return NextResponse.json({ error: "无效的供应商模型设置。" }, { status: 400 });
  }
  try {
    await saveModelTestPreferences(provider, changes);
    const preferences = (await getProviderModelPreferences()).get(provider);
    return NextResponse.json({ preferences }, { headers });
  } catch {
    return NextResponse.json({ error: "无法保存模型可见性。" }, { status: 500, headers });
  }
}

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind = "llm" } = await request.json();
    if (typeof model !== "string" || !model.trim()) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const target = kind === "llm" && getTestedModelTarget(model);
    if (!target) return NextResponse.json(await pingModelByKind(model, kind));

    const context = await getModelTestContext(target.provider);
    if (!context) return NextResponse.json({ ok: false, error: NO_TEST_CONTEXT }, { status: 409 });
    const probe = await pingModelByKind(model, kind, undefined, { apiKey: context.apiKey }).catch(error => {
      if (target.provider === "gemini" && (error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError)) {
        return { ok: false, error: "检测超时或网络连接中断，请重试。", status: error instanceof TypeError ? 502 : 504, source: "router", testStatus: "retry" };
      }
      if (error.name !== "TimeoutError") throw error;
      return { ok: false, error: "检测超时，请重试。", status: 504 };
    });
    const error = probe.error ? safeDiagnosticMessage(probe.error) : null;
    const testedAt = Date.now();
    const testStatus = probe.ok ? "ok" : probe.testStatus || "error";
    const result = { status: testStatus, latencyMs: probe.latencyMs, testedAt };
    if (target.provider === "gemini") {
      result.httpStatus = probe.status;
      result.source = probe.source || "upstream";
      if (error) result.error = error;
    }
    await saveModelTest(context.scope, target.model, result);
    return NextResponse.json({ ...probe, error, testStatus, testedAt }, { headers });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
