"use client";

import { useState } from "react";
import { Button, Input } from "@/shared/components";

const EMPTY_FILTERS = {
  before: "",
  after: "",
  provider: "",
  model: "",
  clientIp: "",
  status: "",
  connectionId: "",
};

export default function AuditLogsCleanup() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  const updateFilter = (field, value) => {
    setFilters((prev) => ({ ...prev, [field]: value }));
  };

  const buildPayload = () => {
    const payload = {};
    for (const [key, value] of Object.entries(filters)) {
      const trimmed = String(value || "").trim();
      if (trimmed) payload[key] = trimmed;
    }
    return payload;
  };

  const clearAuditLogs = async (all = false) => {
    const payload = all ? { all: true } : buildPayload();
    if (!all && Object.keys(payload).length === 0) {
      setStatus({ type: "error", message: "Set at least one filter, or use Clear all audit logs." });
      return;
    }

    const confirmed = window.confirm(
      all
        ? "Clear all audit logs? This removes usage history, daily usage aggregates, and request details."
        : "Clear audit logs matching the current filters? This cannot be undone."
    );
    if (!confirmed) return;

    setLoading(true);
    setStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings/audit-logs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to clear audit logs");

      const usageCount = data.deleted?.usageHistory || 0;
      const detailCount = data.deleted?.requestDetails || 0;
      setStatus({
        type: "success",
        message: `Audit logs cleared: ${usageCount} usage records, ${detailCount} request details.`,
      });
    } catch (err) {
      setStatus({ type: "error", message: err.message || "Failed to clear audit logs" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pt-4 border-t border-border">
      <div>
        <p className="font-medium text-sm sm:text-base">Audit Logs</p>
        <p className="text-xs sm:text-sm text-text-muted">
          Clear usage history, daily aggregates, and request details.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input
          type="date"
          label="Before"
          value={filters.before}
          onChange={(e) => updateFilter("before", e.target.value)}
          disabled={loading}
        />
        <Input
          type="date"
          label="After"
          value={filters.after}
          onChange={(e) => updateFilter("after", e.target.value)}
          disabled={loading}
        />
        <Input
          label="Provider"
          placeholder="openai"
          value={filters.provider}
          onChange={(e) => updateFilter("provider", e.target.value)}
          disabled={loading}
        />
        <Input
          label="Model"
          placeholder="gpt-5"
          value={filters.model}
          onChange={(e) => updateFilter("model", e.target.value)}
          disabled={loading}
        />
        <Input
          label="Client IP"
          placeholder="192.168.1.112"
          value={filters.clientIp}
          onChange={(e) => updateFilter("clientIp", e.target.value)}
          disabled={loading}
        />
        <Input
          label="Status"
          placeholder="ok"
          value={filters.status}
          onChange={(e) => updateFilter("status", e.target.value)}
          disabled={loading}
        />
        <Input
          label="Connection ID"
          placeholder="provider connection id"
          value={filters.connectionId}
          onChange={(e) => updateFilter("connectionId", e.target.value)}
          disabled={loading}
          className="sm:col-span-2"
        />
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <Button
          variant="secondary"
          icon="filter_alt_off"
          onClick={() => clearAuditLogs(false)}
          loading={loading}
          className="w-full sm:w-auto"
        >
          Clear matching logs
        </Button>
        <Button
          variant="danger"
          icon="delete_forever"
          onClick={() => clearAuditLogs(true)}
          loading={loading}
          className="w-full sm:w-auto"
        >
          Clear all audit logs
        </Button>
      </div>
      {status.message && (
        <p className={`text-sm ${status.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
          {status.message}
        </p>
      )}
    </div>
  );
}
