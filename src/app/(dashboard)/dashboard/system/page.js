import SystemMetrics from "./SystemMetrics";
import { getSystemMetrics } from "@/app/api/system/metrics/route";

export const dynamic = "force-dynamic";

export default async function SystemPage() {
  const initialMetrics = await getSystemMetrics();
  return <SystemMetrics initialMetrics={initialMetrics} />;
}
