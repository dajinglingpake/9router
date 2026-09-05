"use client";

import { Suspense, useEffect, useState, useTransition } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

const TAB_VALUES = ["overview", "logs", "details"];

function getTabFromSearchParams(searchParams) {
  const tab = searchParams.get("tab");
  return TAB_VALUES.includes(tab) ? tab : "overview";
}

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");
  const [activeTab, setActiveTab] = useState(() => getTabFromSearchParams(searchParams));
  const [, startTransition] = useTransition();

  // Keep the tab immediately interactive while the App Router updates the URL.
  useEffect(() => {
    const nextTab = getTabFromSearchParams(searchParams);
    startTransition(() => {
      setActiveTab((currentTab) => currentTab === nextTab ? currentTab : nextTab);
    });
  }, [searchParams, startTransition]);

  const handleTabChange = (value) => {
    if (!TAB_VALUES.includes(value) || value === activeTab) return;
    setActiveTab(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value === "overview") {
      // Overview is the default view, so returning to it should not make
      // future refreshes reopen the Details tab.
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const query = params.toString();
    router.push(`/dashboard/usage${query ? `?${query}` : ""}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + period selector on same row */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "details", label: "Details" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab === "overview" && (
          <SegmentedControl
            options={PERIODS}
            value={period}
            onChange={setPeriod}
            size="sm"
            className="w-full sm:w-auto"
          />
        )}
      </div>

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}
