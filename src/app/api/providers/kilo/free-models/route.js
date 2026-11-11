import { resolveKiloModels } from "@/lib/kiloModels";

export async function GET() {
  const catalog = await resolveKiloModels();
  const models = catalog.models.filter(model => model.isFree).map(model => ({
    id: model.id, name: model.name, isFree: true, context_length: model.capabilities.contextWindow || 0,
  }));
  return Response.json({ ...catalog, models }, { status: catalog.error ? 502 : 200 });
}
