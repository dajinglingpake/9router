import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { getApiKeys } from "@/lib/db";
import { getUsageRequestDetails } from "@/lib/db";
import { getSettings } from "@/lib/db";

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, apiKey, apiKeyName, clientIp, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const apiKey = searchParams.get("apiKey");
    const apiKeyName = searchParams.get("apiKeyName")?.trim();
    const clientIp = searchParams.get("clientIp");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (apiKey?.trim()) filter.apiKey = apiKey.trim();
    if (apiKeyName) {
      const keys = await getApiKeys();
      filter.apiKeyValues = keys
        .filter((key) => key.name?.toLowerCase().includes(apiKeyName.toLowerCase()))
        .map((key) => key.key);
    }
    if (clientIp) filter.clientIp = clientIp;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    let result = await getRequestDetails(filter);
    // Usage tracking remains enabled when full request logging is disabled.
    // Fall back to its metadata rows so the details tab still shows real calls.
    if (result.pagination.totalItems === 0) {
      result = await getUsageRequestDetails(filter);
    }

    const settings = await getSettings();
    const details = settings.enableObservability === true
      ? result.details || []
      : (result.details || []).map((d) => {
        const redacted = { ...d };
        for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
          if (redacted[key] !== undefined) redacted[key] = { redacted: true };
        }
        return redacted;
      });

    return NextResponse.json({ ...result, details });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
