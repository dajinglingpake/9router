import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";
import CodexQuotaSummary from "./local/CodexQuotaSummary";

export default function QuotaPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <CodexQuotaSummary />
      <ProviderLimits />
    </Suspense>
  );
}
