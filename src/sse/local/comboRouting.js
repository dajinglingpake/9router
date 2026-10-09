import { getSettings } from "@/lib/localDb";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";

export async function handleLocalCombo(body, models, comboName, handleSingleModel) {
  const settings = await getSettings();
  const name = comboName.startsWith("cc/") ? comboName.slice(3) : comboName;
  const strategy = settings.comboStrategies?.[name] || {};
  return handleComboChat({
    body, models, handleSingleModel, log, comboName: name,
    comboStrategy: strategy.fallbackStrategy || settings.comboStrategy || "fallback",
    comboStickyLimit: strategy.stickyRoundRobinLimit ?? settings.comboStickyRoundRobinLimit ?? 1,
  });
}
