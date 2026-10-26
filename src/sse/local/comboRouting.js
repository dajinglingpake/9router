import { getSettings } from "@/lib/localDb";
import { handleComboChat } from "open-sse/services/combo.js";
import { resolveSmartChoice } from "../services/systemoneRouter.js";
import * as log from "../utils/logger.js";

export async function handleLocalCombo(body, models, comboName, handleSingleModel, { request = null, sessionId = null } = {}) {
  const settings = await getSettings();
  const name = comboName.startsWith("cc/") ? comboName.slice(3) : comboName;
  const strategy = settings.comboStrategies?.[name] || {};
  const comboStrategy = strategy.fallbackStrategy || settings.comboStrategy || "fallback";
  return handleComboChat({
    body, models, handleSingleModel, log, comboName: name,
    comboStrategy,
    comboStickyLimit: strategy.stickyRoundRobinLimit ?? settings.comboStickyRoundRobinLimit ?? 1,
    sessionId,
    smartPolicy: strategy.smartPolicy || "smart",
    sessionSticky: strategy.sessionSticky !== false,
    confidenceThreshold: typeof strategy.confidenceThreshold === "number" ? strategy.confidenceThreshold : 0.8,
    resolveSmartChoice: comboStrategy === "smart"
      ? (body, models) => resolveSmartChoice({ body, models, routerModel: strategy.routerModel, log, request })
      : null,
  });
}
