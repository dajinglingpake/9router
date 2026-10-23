"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const TIMING_GROUPS = [
  {
    id: "interval",
    label: "Request interval",
    minKey: "minRequestIntervalMs",
    maxKey: "maxRequestIntervalMs",
    minLabel: "Request interval minimum (seconds)",
    maxLabel: "Request interval maximum (seconds)",
    minimum: 0,
    maximum: 60,
    defaultSeconds: 0,
    hint: "0 means disabled. Retries are included.",
  },
  {
    id: "cooldown",
    label: "Account cooldown",
    minKey: "accountCooldownMinMs",
    maxKey: "accountCooldownMaxMs",
    minLabel: "Account cooldown minimum (seconds)",
    maxLabel: "Account cooldown maximum (seconds)",
    minimum: 1,
    maximum: 3600,
    defaultSeconds: 30,
    hint: "Used for transient upstream 502/503 errors.",
  },
];

function commonSeconds(connections, group, key) {
  const values = connections.map((connection) => (
    Number(connection[key]) || Number(connection[group.minKey]) || group.defaultSeconds * 1000
  ) / 1000);
  return values.every((value) => value === values[0]) ? String(values[0]) : "";
}

export default function BulkConnectionTimingModal({ connections, onSaved, onClose }) {
  const [settings, setSettings] = useState(() => {
    const concurrencyValues = connections.map(connection => Number(connection.maxConcurrency) || 0);
    return {
      concurrency: {
        enabled: false,
        value: concurrencyValues.every(value => value === concurrencyValues[0]) ? String(concurrencyValues[0] ?? 0) : "",
      },
      ...Object.fromEntries(TIMING_GROUPS.map((group) => [
        group.id,
        {
          enabled: false,
          minimum: commonSeconds(connections, group, group.minKey),
          maximum: commonSeconds(connections, group, group.maxKey),
        },
      ])),
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState([]);

  const updateSetting = (id, changes) => {
    setSettings((previous) => ({ ...previous, [id]: { ...previous[id], ...changes } }));
    setError("");
    setFailures([]);
  };

  const handleClose = () => {
    if (!saving) onClose();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving || connections.length === 0) return;
    const updates = {};
    if (settings.concurrency.enabled) {
      const value = Number(settings.concurrency.value);
      if (settings.concurrency.value.trim() === "" || !Number.isInteger(value) || value < 0 || value > 1000) {
        setError(`${translate("Max concurrent requests")}: ${translate("Enter an integer between 0 and 1000.")}`);
        return;
      }
      updates.maxConcurrency = value;
    }
    for (const group of TIMING_GROUPS) {
      const setting = settings[group.id];
      if (!setting.enabled) continue;
      const minimum = Number(setting.minimum);
      const maximum = Number(setting.maximum);
      if (setting.minimum.trim() === "" || setting.maximum.trim() === ""
        || !Number.isFinite(minimum) || !Number.isFinite(maximum)
        || minimum < group.minimum || maximum > group.maximum || minimum > maximum) {
        setError(`${translate(group.label)}: ${translate("Enter both values within the allowed range, with minimum no greater than maximum.")}`);
        return;
      }
      updates[group.minKey] = Math.round(minimum * 1000);
      updates[group.maxKey] = Math.round(maximum * 1000);
    }
    if (Object.keys(updates).length === 0) return;

    setSaving(true);
    setError("");
    setFailures([]);
    try {
      const failed = [];
      for (const connection of connections) {
        try {
          const response = await fetch(`/api/providers/${connection.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `${translate("Request failed")}: ${response.status}`);
          }
        } catch (err) {
          failed.push({ id: connection.id, name: connection.name || connection.email || connection.id, error: err.message });
        }
      }
      if (failed.length < connections.length) await onSaved();
      if (failed.length === 0) {
        onClose();
      } else {
        setError(`${translate("Saved")}: ${connections.length - failed.length}; ${translate("failed")}: ${failed.length}`);
        setFailures(failed);
      }
    } catch (err) {
      setError(err.message || translate("Request failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen title={translate("Bulk edit settings")} onClose={handleClose} size="lg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          {translate("Selected connections")}: {connections.length}. {translate("Only checked settings are applied to selected connections.")}
        </p>
        <fieldset disabled={saving} className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={settings.concurrency.enabled}
              onChange={event => updateSetting("concurrency", { enabled: event.target.checked })}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary" />
            {translate("Max concurrent requests")}
          </label>
          <Input aria-label={translate("Max concurrent requests")} type="number" min={0} max={1000} step="1"
            value={settings.concurrency.value} placeholder={translate("Mixed values")}
            disabled={!settings.concurrency.enabled || saving} required={settings.concurrency.enabled}
            hint={translate("0 means unlimited.")}
            onChange={event => updateSetting("concurrency", { value: event.target.value })} />
        </fieldset>
        {TIMING_GROUPS.map((group) => (
          <fieldset key={group.id} disabled={saving} className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={settings[group.id].enabled}
                onChange={(event) => updateSetting(group.id, { enabled: event.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary" />
              {translate(group.label)}
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {["minimum", "maximum"].map((bound) => (
                <Input key={bound} label={translate(bound === "minimum" ? group.minLabel : group.maxLabel)}
                  aria-label={translate(bound === "minimum" ? group.minLabel : group.maxLabel)}
                  type="number" min={group.minimum} max={group.maximum} step="0.001"
                  value={settings[group.id][bound]} placeholder={translate("Mixed values")}
                  disabled={!settings[group.id].enabled || saving} required={settings[group.id].enabled}
                  onChange={(event) => updateSetting(group.id, { [bound]: event.target.value })} />
              ))}
            </div>
            <p className="text-xs text-text-muted">{translate(group.hint)}</p>
          </fieldset>
        ))}
        {error && <p role="alert" className="text-sm text-red-500 break-words">{error}</p>}
        {failures.length > 0 && (
          <ul className="max-h-32 overflow-y-auto text-xs text-red-500">
            {failures.map((failure) => <li key={failure.id} className="break-words">{failure.name}: {failure.error}</li>)}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={handleClose} disabled={saving}>{translate("Cancel")}</Button>
          <Button type="submit" loading={saving} disabled={connections.length === 0 || (!settings.concurrency.enabled && !TIMING_GROUPS.some((group) => settings[group.id].enabled))}>
            {translate("Apply to selected")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

BulkConnectionTimingModal.propTypes = {
  connections: PropTypes.array.isRequired,
  onSaved: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
