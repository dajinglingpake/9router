"use client";

import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Card from "@/shared/components/Card";

export default function LatencyChart({ period = "today", embedded = false }) {
  const [data, setData] = useState([]);
  const [hiddenModels, setHiddenModels] = useState(() => new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/usage/latency?period=${period}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : [])
      .then((nextData) => setData(nextData?.data ? nextData : { models: [], data: [] }))
      .catch((error) => { if (error.name !== "AbortError") setData([]); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [period]);

  useEffect(() => {
    setHiddenModels((current) => new Set([...current].filter((model) => data.models?.includes(model))));
  }, [data.models]);

  const toggleModel = (entry) => {
    const model = entry?.dataKey;
    if (!model) return;
    setHiddenModels((current) => {
      const next = new Set(current);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const renderModelControls = () => (
    <div className="flex flex-wrap gap-x-2 gap-y-1.5" aria-label="Model visibility">
      {data.models.map((model, index) => {
        const hidden = hiddenModels.has(model);
        const color = ["#f97316", "#2563eb", "#16a34a", "#dc2626", "#9333ea"][index % 5];
        return (
          <button
            key={model}
            type="button"
            onClick={() => toggleModel({ dataKey: model })}
            aria-pressed={!hidden}
            className={`inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded px-1.5 transition-opacity hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${hidden ? "opacity-40" : ""}`}
            title={hidden ? "Show model" : "Hide model"}
          >
            <span className="h-0.5 w-3 rounded" style={{ backgroundColor: color }} aria-hidden="true" />
            <span>{model}</span>
          </button>
        );
      })}
    </div>
  );

  const Wrapper = embedded ? "div" : Card;
  return (
    <Wrapper className={embedded ? "flex min-w-0 flex-col gap-3" : "flex min-w-0 flex-col gap-3 p-3 sm:p-4"}>
      <div>
        <h3 className="text-sm font-semibold text-text-main">Average Latency</h3>
      </div>
      {loading ? <div className="h-48 flex items-center justify-center text-sm text-text-muted">Loading...</div> : !data.data?.some((point) => data.models.some((model) => point[model] != null)) ? <div className="h-48 flex items-center justify-center text-sm text-text-muted">No latency data for this period</div> : (
        <>
          {renderModelControls()}
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data.data} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }} tickLine={false} axisLine={false} unit=" ms" width={60} />
            <Tooltip formatter={(value, name) => [`${value} ms`, "Average latency"]} />
            {data.models.map((model, index) => <Line key={model} type="monotone" dataKey={model} hide={hiddenModels.has(model)} connectNulls={false} stroke={["#f97316", "#2563eb", "#16a34a", "#dc2626", "#9333ea"][index % 5]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />)}
          </LineChart>
        </ResponsiveContainer>
        </>
      )}
    </Wrapper>
  );
}
