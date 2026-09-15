import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";
import { normalizeAlertConfig, publicAlertConfig } from "@/lib/alerts/config.js";
import { getAlertStatus, queueAlert } from "@/lib/alerts/wecom.js";
import { checkAccountAlerts } from "@/lib/alerts/monitor.js";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  return Response.json({ ...publicAlertConfig((await getSettings()).wecomAlerts), status: await getAlertStatus() }, { headers });
}

export async function PATCH(request) {
  try {
    const input = await request.json();
    const config = normalizeAlertConfig(input, (await getSettings()).wecomAlerts);
    await updateSettings({ wecomAlerts: config });
    void checkAccountAlerts();
    return Response.json(publicAlertConfig(config), { headers });
  } catch {
    return Response.json({ error: "保存失败，请检查 Webhook 地址和告警阈值" }, { status: 400, headers });
  }
}

export async function POST() {
  try {
    if (!(await getSettings()).wecomAlerts?.webhookUrl) return Response.json({ error: "请先保存 Webhook" }, { status: 400, headers });
    const sent = await queueAlert({ key: "test", test: true, cooldownMs: 60000, content: "9router 告警测试：企业微信群推送已连通。" });
    return Response.json({ message: sent ? "测试消息已发送" : "请稍后再试，测试消息每分钟最多一条" }, { headers });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502, headers });
  }
}
