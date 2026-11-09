import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { getKeyPlanCatalog } from "@/sse/services/keyPlanShare.js";

export const dynamic = "force-dynamic";

// GET /api/keys/plan-catalog?keyId=... - every connected account's quota windows
// (5h / weekly / ...) a key's share can be set on, plus the key's estimated use.
export async function GET(request) {
  try {
    const keyId = new URL(request.url).searchParams.get("keyId");
    const key = keyId ? await getApiKeyById(keyId) : null;
    if (keyId && !key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    return NextResponse.json({ accounts: await getKeyPlanCatalog(key) });
  } catch (error) {
    console.log("Error building plan catalog:", error);
    return NextResponse.json({ error: "Failed to load plan catalog" }, { status: 500 });
  }
}
