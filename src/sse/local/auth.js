import { validateApiKey } from "@/lib/localDb";
import { extractClientIp } from "../utils/clientIp.js";

export { extractApiKey } from "../services/auth.js";
export { getProviderCredentials } from "./accountSelection.js";
export { markAccountUnavailable, clearAccountError } from "./accountHealth.js";

export async function isValidApiKey(apiKey, request) {
  if (!apiKey) return false;
  return validateApiKey(apiKey, extractClientIp(request));
}
