import { NextResponse } from "next/server";
import { getApiKeyById, getSettings } from "@/lib/localDb";
import { getKeyQuotaStatus } from "@/sse/services/keyQuota.js";

export const dynamic = "force-dynamic";

// GET /api/keys/[id]/quota - usage vs. limit for each window the key limits
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    const settings = await getSettings();
    return NextResponse.json({ quota: await getKeyQuotaStatus(key, settings) });
  } catch (error) {
    console.log("Error fetching key quota:", error);
    return NextResponse.json({ error: "Failed to fetch key quota" }, { status: 500 });
  }
}
