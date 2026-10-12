import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";

function loginError(message, status) {
  return Object.assign(new Error(message), { status });
}

export async function getCodexReloginTarget(connectionId) {
  if (typeof connectionId !== "string" || !connectionId.trim()) {
    throw loginError("重新登录的账号 ID 无效。", 400);
  }
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) throw loginError("账号已被删除，请刷新页面。", 404);
  if (connection.provider !== "codex" || !["oauth", "access_token"].includes(connection.authType)) {
    throw loginError("此账号不支持 Codex 重新登录。", 400);
  }
  return connection;
}

export async function reloginCodexConnection(connectionId, data) {
  const existing = await getCodexReloginTarget(connectionId);

  // A login for another identity must not inherit this account's dedicated keys.
  const oldEmail = existing.email?.trim().toLowerCase();
  const newEmail = data.email?.trim().toLowerCase();
  if (oldEmail && oldEmail !== newEmail) {
    throw loginError("登录账号与原账号不一致，请使用原账号重新登录。", 409);
  }
  const previousAccountId = existing.providerSpecificData?.chatgptAccountId;
  if (previousAccountId && previousAccountId !== data.providerSpecificData?.chatgptAccountId) {
    throw loginError("登录账号或工作空间与原账号不一致，请使用原账号重新登录。", 409);
  }

  // Patch credentials only, preserving routing, bindings and the enabled state.
  const patch = {};
  for (const field of ["authType", "accessToken", "email", "expiresIn", "tokenType", "scope"]) {
    if (data[field] !== undefined) patch[field] = data[field];
  }
  Object.assign(patch, {
    refreshToken: data.refreshToken ?? null,
    idToken: data.idToken ?? null,
    expiresAt: data.expiresAt ?? null,
    lastRefreshAt: data.lastRefreshAt || new Date().toISOString(),
    providerSpecificData: { ...existing.providerSpecificData, ...data.providerSpecificData,
      authMethod: data.authType === "access_token" ? "access_token" : "oauth" },
    testStatus: "active",
  });
  const connection = await updateProviderConnection(existing.id, patch);
  if (!connection) throw loginError("账号已被删除，请刷新页面。", 404);
  return connection;
}
