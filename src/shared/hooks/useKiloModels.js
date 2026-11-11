"use client";

import { useEffect, useState } from "react";

const empty = { models: [], loading: false, warning: null };

export function useKiloModels(connections, enabled) {
  const scope = enabled ? JSON.stringify(connections.filter(conn => conn.provider === "kilocode" && conn.isActive !== false)
    .map(conn => [conn.id, conn.providerSpecificData?.orgId, conn.updatedAt])) : null;
  const [catalog, setCatalog] = useState(empty);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    if (scope === null) return;
    const controller = new AbortController();
    setCatalog(previous => ({ ...(previous.scope === scope ? previous : empty), scope, loading: true, warning: null }));

    async function load() {
      try {
        const url = "/api/providers/kilo/models" + (refreshCount ? "?refresh=1" : "");
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!Array.isArray(data.models)) throw new Error(data.error || "Kilo Code catalog unavailable");
        if (!controller.signal.aborted) setCatalog({
          scope, models: data.models, loading: false,
          warning: data.warning || data.error || (data.models.length ? null : "Kilo Code returned no available models."),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setCatalog(previous => ({
          ...previous, loading: false,
          warning: previous.models.length ? `${error.message}. Showing the last successful list.` : error.message,
        }));
      }
    }
    load();
    return () => controller.abort();
  }, [scope, refreshCount]);

  return { ...(catalog.scope === scope ? catalog : empty), refresh: () => setRefreshCount(count => count + 1) };
}
