// Per-key share of a provider plan quota (e.g. Claude 5h / weekly).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateKeyLimitsInput } from "@/shared/utils/keyLimits.js";
import { inferQuotaWindowMs, quotaModelLikePatterns } from "@/shared/constants/keyLimits.js";

describe("plan limit validation", () => {
  it("accepts per-provider quota keys with a window and percent in (0,100]", () => {
    const r = validateKeyLimitsInput({ plan: {
      claude: { "session (5h)": 50, "weekly (7d)": 50, "weekly opus (7d)": null },
      antigravity: { gemini_session: 30, claude_gpt_weekly: 40 },
      codex: { session: 50, weekly: 50 },
    } });
    expect(r).toEqual({ ok: true, value: { plan: {
      claude: { "session (5h)": 50, "weekly (7d)": 50 },
      antigravity: { gemini_session: 30, claude_gpt_weekly: 40 },
      codex: { session: 50, weekly: 50 },
    } } });
  });
  it("rejects bad provider / quota / percent", () => {
    expect(validateKeyLimitsInput({ plan: { claude: { "mystery": 50 } } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ plan: { claude: { "session (5h)": 0 } } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ plan: { claude: { "session (5h)": 101 } } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ plan: { "bad provider!": { session: 5 } } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ plan: { claude: [] } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ plan: [] }).ok).toBe(false);
  });
  it("infers window length from provider quota keys", () => {
    expect(inferQuotaWindowMs("session (5h)")).toBe(5 * 3600e3);
    expect(inferQuotaWindowMs("weekly (7d)")).toBe(7 * 86400e3);
    expect(inferQuotaWindowMs("gemini_session")).toBe(5 * 3600e3);
    expect(inferQuotaWindowMs("claude_gpt_weekly")).toBe(7 * 86400e3);
    expect(inferQuotaWindowMs("weekly")).toBe(7 * 86400e3);
    expect(inferQuotaWindowMs("Plan (USD)")).toBeNull();
  });
  it("maps quota families to model patterns", () => {
    expect(quotaModelLikePatterns("gemini_weekly")).toEqual(["%gemini%"]);
    expect(quotaModelLikePatterns("claude_gpt_session")).toEqual(["%claude%", "%gpt%"]);
    expect(quotaModelLikePatterns("session (5h)")).toBeNull();
  });
});

describe("estimateKeyPlanPercent", () => {
  it("charges the key its token share of the plan's used %", async () => {
    const { estimateKeyPlanPercent } = await import("@/sse/services/keyPlanShare.js");
    const future = new Date(Date.now() + 3600e3).toISOString();
    expect(estimateKeyPlanPercent({ used: 42, total: 100, resetAt: future }, { all: 1000, key: 500 })).toBeCloseTo(21);
    expect(estimateKeyPlanPercent({ used: 80, total: 100, resetAt: future }, { all: 1000, key: 1000 })).toBeCloseTo(80);
  });
  it("reads utilization from remainingPercentage (Antigravity) before used/total", async () => {
    const { quotaUsedPercent } = await import("@/sse/services/keyPlanShare.js");
    expect(quotaUsedPercent({ used: 237, total: 1000, remainingPercentage: 76.3 })).toBeCloseTo(23.7);
    expect(quotaUsedPercent({ used: 2, total: 100 })).toBe(2);
    expect(quotaUsedPercent({})).toBeNull();
  });
  it("is null (fail-open) with no utilization, no tokens, or a rolled-over window", async () => {
    const { estimateKeyPlanPercent } = await import("@/sse/services/keyPlanShare.js");
    const future = new Date(Date.now() + 3600e3).toISOString();
    expect(estimateKeyPlanPercent({ used: 0, total: 100, resetAt: future }, { all: 10, key: 10 })).toBeNull();
    expect(estimateKeyPlanPercent({ used: 50, total: 100, resetAt: future }, { all: 0, key: 0 })).toBeNull();
    expect(estimateKeyPlanPercent({ used: 50, total: 100, resetAt: new Date(Date.now() - 1000).toISOString() }, { all: 10, key: 5 })).toBeNull();
    expect(estimateKeyPlanPercent(undefined, { all: 10, key: 5 })).toBeNull();
  });
});

describe("getPlanBlockedConnections", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-plan-"));
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
    vi.doUnmock("open-sse/services/usage.js");
  });

  async function setup(used5h, usedWeek) {
    delete global._dbAdapter;
    vi.resetModules();
    const resetAt = new Date(Date.now() + 3600e3).toISOString();
    vi.doMock("open-sse/services/usage.js", () => ({
      getUsageForProvider: async () => ({ quotas: {
        "session (5h)": { used: used5h, total: 100, resetAt },
        "weekly (7d)": { used: usedWeek, total: 100, resetAt },
      } }),
    }));
    const db = await import("@/lib/db/index.js");
    const svc = await import("@/sse/services/keyPlanShare.js");
    const conn = await db.createProviderConnection({ provider: "claude", authType: "oauth", name: "Account 1", accessToken: "t", isActive: true });
    const a = await db.createApiKey("A", "m");
    const b = await db.createApiKey("B", "m");
    await db.updateApiKey(a.id, { limits: { plan: { claude: { "session (5h)": 50, "weekly (7d)": 50 } } } });
    const log = (key, tokens) => db.saveRequestUsage({ provider: "claude", model: "m", apiKey: key.key, connectionId: conn.id, tokens: { prompt_tokens: tokens, completion_tokens: 0 } });
    return { svc, a, b, conn, log };
  }

  it("blocks key A on the account once its estimated share reaches 50%", async () => {
    const { svc, a, b, conn, log } = await setup(60, 20);
    await log(a, 900); await log(b, 100); // A = 90% of tokens, plan 60% used -> A ~54% of the 5h window
    const r = await svc.getPlanBlockedConnections(a.key, "claude");
    expect(r.blocked.has(conn.id)).toBe(true);
    expect(r.details[0]).toMatch(/session \(5h\)/);
  });

  it("does not block while under share, and never blocks key B (no plan limits)", async () => {
    const { svc, a, b, log } = await setup(60, 20);
    await log(a, 100); await log(b, 900); // A = 10% of tokens -> ~6%
    expect((await svc.getPlanBlockedConnections(a.key, "claude")).blocked.size).toBe(0);
    expect((await svc.getPlanBlockedConnections(b.key, "claude")).blocked.size).toBe(0);
  });
});

describe("catalog + per-model attribution", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;
  beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-plan2-")); process.env.DATA_DIR = tempDir; });
  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
    vi.doUnmock("open-sse/services/usage.js");
  });

  it("antigravity: Gemini quota only counts Gemini models; catalog lists every usable quota", async () => {
    delete global._dbAdapter;
    vi.resetModules();
    const resetAt = new Date(Date.now() + 3600e3).toISOString();
    vi.doMock("open-sse/services/usage.js", () => ({
      getUsageForProvider: async () => ({ quotas: {
        gemini_session: { used: 600, total: 1000, remainingPercentage: 40, resetAt, displayName: "Gemini (5h)" },
        claude_gpt_session: { used: 0, total: 1000, remainingPercentage: 100, resetAt, displayName: "Claude & GPT (5h)" },
        review_weekly: { used: 1, total: 100, resetAt },
        "Plan (USD)": { used: 1, total: 10 },
      } }),
    }));
    const db = await import("@/lib/db/index.js");
    const svc = await import("@/sse/services/keyPlanShare.js");
    const conn = await db.createProviderConnection({ provider: "antigravity", authType: "oauth", name: "ag1", accessToken: "t", isActive: true });
    const a = await db.createApiKey("A", "m");
    await db.updateApiKey(a.id, { limits: { plan: { antigravity: { gemini_session: 50 } } } });
    const log = (model, tokens, key) => db.saveRequestUsage({ provider: "antigravity", model, apiKey: key.key, connectionId: conn.id, tokens: { prompt_tokens: tokens, completion_tokens: 0 } });
    await log("gemini-3-pro", 100, a);        // A: 100 of 100 Gemini tokens -> 60% used -> over 50%
    await log("claude-sonnet-4", 100000, await db.createApiKey("B", "m")); // other family: must not dilute
    expect((await svc.getPlanBlockedConnections(a.key, "antigravity")).blocked.has(conn.id)).toBe(true);

    const catalog = await svc.getKeyPlanCatalog(await db.getApiKeyById(a.id));
    expect(catalog).toHaveLength(1);
    expect(catalog[0].quotas.map((q) => q.key)).toEqual(["gemini_session", "claude_gpt_session"]);
    expect(catalog[0].quotas[0]).toMatchObject({ label: "Gemini (5h)", usedPercent: 60, keyPercent: 60 });
  });
});
