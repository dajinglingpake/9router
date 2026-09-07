import { NextResponse } from "next/server";
import { getDistinctClientIps, getDistinctModels, getDistinctProviders } from "@/lib/requestDetailsDb";
import { getApiKeys } from "@/lib/db";
import { getDistinctUsageClientIps, getDistinctUsageModels, getDistinctUsageProviders } from "@/lib/db";
import { getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/providers
 * Returns unique providers and models from request details for dashboard filters.
 */
export async function GET() {
  try {
    // Query DISTINCT provider column directly — avoids parsing every row's
    // full JSON blob (can be hundreds of MB), which previously caused OOM.
    const [detailProviderIds, detailModels, detailClientIps, usageProviderIds, usageModels, usageClientIps, apiKeys] = await Promise.all([
      getDistinctProviders(),
      getDistinctModels(),
      getDistinctClientIps(),
      getDistinctUsageProviders(),
      getDistinctUsageModels(),
      getDistinctUsageClientIps(),
      getApiKeys(),
    ]);
    const providerIds = [...new Set([...detailProviderIds, ...usageProviderIds])].sort();
    const models = [...new Set([...detailModels, ...usageModels])].sort();
    const clientIps = [...new Set([...detailClientIps, ...usageClientIps])].sort();

    const providerNodes = await getProviderNodes();
    const nodeMap = {};
    for (const node of providerNodes) {
      nodeMap[node.id] = node.name;
    }

    const providers = providerIds.map(providerId => {
      let name = providerId;
      if (nodeMap[providerId]) {
        name = nodeMap[providerId];
      } else {
        const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
        if (providerConfig?.name) name = providerConfig.name;
      }
      return { id: providerId, name };
    });

    return NextResponse.json({
      providers,
      models,
      clientIps,
      apiKeys: apiKeys.map(({ id, name }) => ({ id, name })),
    });
  } catch (error) {
    console.error("[API] Failed to get providers:", error);
    return NextResponse.json(
      { error: "Failed to fetch providers" },
      { status: 500 }
    );
  }
}
