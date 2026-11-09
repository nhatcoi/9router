// Per-API-key token limits: enforcement against real usageHistory in a temp DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const quota = await import("@/sse/services/keyQuota.js");
  return { db, quota };
}

const req = (key) => new Request("http://x/v1/chat/completions", { headers: key ? { Authorization: `Bearer ${key}` } : {} });

async function use(db, apiKey, tokens, ageMs = 0) {
  await db.saveRequestUsage({
    provider: "openai", model: "gpt", apiKey,
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    tokens: { prompt_tokens: tokens, completion_tokens: 0 },
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-quota-"));
  process.env.DATA_DIR = tempDir;
});
afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("enforceKeyQuota", () => {
  it("passes keys with no limits, unknown keys and no key", async () => {
    const { db, quota } = await boot();
    const k = await db.createApiKey("free", "m");
    await use(db, k.key, 1e9);
    expect(await quota.enforceKeyQuota(req(k.key))).toBeNull();
    expect(await quota.enforceKeyQuota(req("sk-unknown"))).toBeNull();
    expect(await quota.enforceKeyQuota(req(null))).toBeNull();
  });

  it("blocks with 429 once the absolute 5h cap is reached, ignoring older usage", async () => {
    const { db, quota } = await boot();
    const k = await db.createApiKey("capped", "m");
    await db.updateApiKey(k.id, { limits: { "5h": { mode: "tokens", value: 1000 } } });
    await use(db, k.key, 5000, 6 * 3600e3); // outside the 5h window
    await use(db, k.key, 600);
    expect(await quota.enforceKeyQuota(req(k.key))).toBeNull();
    await use(db, k.key, 500);
    const res = await quota.enforceKeyQuota(req(k.key));
    expect(res.status).toBe(429);
  });

  it("does not count other keys' usage", async () => {
    const { db, quota } = await boot();
    const a = await db.createApiKey("a", "m");
    const b = await db.createApiKey("b", "m");
    await db.updateApiKey(a.id, { limits: { day: { mode: "tokens", value: 100 } } });
    await use(db, b.key, 1e6);
    expect(await quota.enforceKeyQuota(req(a.key))).toBeNull();
  });

  it("percent limit resolves against the settings pool", async () => {
    const { db, quota } = await boot();
    const k = await db.createApiKey("pct", "m");
    await db.updateSettings({ keyLimitPools: { week: 10000 } });
    await db.updateApiKey(k.id, { limits: { week: { mode: "percent", value: 20 } } }); // 2000 tokens
    await use(db, k.key, 1999);
    expect(await quota.enforceKeyQuota(req(k.key))).toBeNull();
    await use(db, k.key, 1);
    expect((await quota.enforceKeyQuota(req(k.key))).status).toBe(429);
    const status = await quota.getKeyQuotaStatus(await db.getApiKeyById(k.id), await db.getSettings());
    expect(status[0]).toMatchObject({ window: "week", used: 2000, max: 2000, percentUsed: 100 });
  });

  it("percent limit with a cleared pool is skipped (fail-open, logged)", async () => {
    const { db, quota } = await boot();
    const k = await db.createApiKey("nopool", "m");
    await db.updateApiKey(k.id, { limits: { week: { mode: "percent", value: 1 } } });
    await use(db, k.key, 1e9);
    expect(await quota.enforceKeyQuota(req(k.key))).toBeNull();
  });

  it("limits survive backup export/import", async () => {
    const { db } = await boot();
    const k = await db.createApiKey("bk", "m");
    await db.updateApiKey(k.id, { limits: { "5h": { mode: "tokens", value: 42 } } });
    const exported = await db.exportDb();
    expect(exported.apiKeys.find((x) => x.id === k.id).limits).toEqual({ "5h": { mode: "tokens", value: 42 } });
  });
});
