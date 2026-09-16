import { NextResponse } from "next/server";
import { getComboById, updateCombo, deleteCombo, getComboByName, getProviderConnectionById } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";
import { getModelInfo } from "@/sse/services/model.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }
    
    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.accountOverrides !== undefined) {
      if (!body.accountOverrides || typeof body.accountOverrides !== "object" || Array.isArray(body.accountOverrides)) {
        return NextResponse.json({ error: "账号定制配置格式不正确。" }, { status: 400 });
      }
      for (const [connectionId, models] of Object.entries(body.accountOverrides)) {
        const connection = await getProviderConnectionById(connectionId);
        if (!connection) return NextResponse.json({ error: "定制配置中的提供商账号不存在，请刷新后重试。" }, { status: 400 });
        if (!Array.isArray(models) || models.length === 0) {
          return NextResponse.json({ error: "账号定制至少需要一个模型；恢复通用配置请移除该账号的定制。" }, { status: 400 });
        }
        for (const model of models) {
          if (typeof model !== "string" || !model.includes("/")) {
            return NextResponse.json({ error: "账号定制请选择该提供商的具体模型。" }, { status: 400 });
          }
          const target = await getModelInfo(model);
          if (target.provider !== connection.provider || !target.model) {
            return NextResponse.json({ error: "账号定制只能使用该账号所属提供商的模型。" }, { status: 400 });
          }
        }
      }
    }
    
    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
      }
      
      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }
    
    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);
    const combo = await updateCombo(id, body);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) resetComboRotation(prev.name);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
