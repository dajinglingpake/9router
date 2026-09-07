// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders, getDistinctModels, getDistinctClientIps,
} from "@/lib/db/index.js";
