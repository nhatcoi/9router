// Per-API-key share of a PROVIDER plan quota: key A may use at most 50% of the
// plan's current 5h window and 50% of its weekly window (Claude, Codex,
// Antigravity, ... — any provider whose Provider Limits card reports quotas).
//
// The provider only reports the plan's TOTAL utilization, so a key's part is
// estimated from 9router's own usage log for that connection and the provider's
// real window:
//
//   keyPercent = providerUsed% * (key tokens / all tokens)   [since window start]
//
// Windows are the provider's own fixed windows (start = resetAt - window
// length, the length inferred from the quota key). Limits are per connection: a
// key that exhausts its share on one account is skipped for that account and
// the normal account fallback moves to the next one. Quotas billed per model
// group (Antigravity Gemini vs Claude & GPT) only count that group's models.
//
// Fail-open: when utilization cannot be read, the window cannot be trusted, or
// there is nothing to calibrate against yet, the key is not blocked.
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getConnectionTokenSplit } from "@/lib/db/repos/usageRepo.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { inferQuotaWindowMs, quotaModelLikePatterns, KEY_PLAN_EXCLUDED_QUOTA_RE } from "@/shared/constants/keyLimits.js";
import * as log from "../utils/logger.js";

const UTILIZATION_TTL_MS = 60_000;
const utilizationCache = new Map(); // connectionId -> { at, quotas }

export async function getConnectionQuotas(connection) {
  const hit = utilizationCache.get(connection.id);
  if (hit && Date.now() - hit.at < UTILIZATION_TTL_MS) return hit.quotas;
  let quotas = null;
  try {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const usage = await getUsageForProvider(connection, {
      connectionProxyEnabled: proxy.connectionProxyEnabled === true,
      connectionProxyUrl: proxy.connectionProxyUrl || "",
      connectionNoProxy: proxy.connectionNoProxy || "",
      vercelRelayUrl: proxy.vercelRelayUrl || "",
      strictProxy: false,
    });
    quotas = usage?.quotas || null;
  } catch (e) {
    log.warn("AUTH", `key-plan: usage lookup failed for ${String(connection.id).slice(0, 8)}: ${e.message}`);
  }
  utilizationCache.set(connection.id, { at: Date.now(), quotas });
  return quotas;
}

/** Provider-reported utilization of one quota as a 0..100 "used" percent, or null. */
export function quotaUsedPercent(quota) {
  if (!quota || typeof quota !== "object") return null;
  if (typeof quota.remainingPercentage === "number") return Math.min(100, Math.max(0, 100 - quota.remainingPercentage));
  if (typeof quota.used === "number" && typeof quota.total === "number" && quota.total > 0) {
    return Math.min(100, Math.max(0, (quota.used / quota.total) * 100));
  }
  return null;
}

/**
 * Pure: the key's estimated % of one quota window, or null when it cannot be
 * estimated (no utilization yet, window already over, nothing logged).
 */
export function estimateKeyPlanPercent(quota, split, now = Date.now()) {
  const used = quotaUsedPercent(quota);
  if (used === null || used <= 0) return null;
  if (!(split?.all > 0)) return null;
  const resetMs = quota.resetAt ? new Date(quota.resetAt).getTime() : NaN;
  if (Number.isFinite(resetMs) && resetMs <= now) return null; // stale cache: window rolled over
  return used * (split.key / split.all);
}

/** Token split for one quota on one connection, or null when its window is unusable. */
async function splitForQuota(connId, rawApiKey, quotaKey, quota, now) {
  const windowMs = inferQuotaWindowMs(quotaKey);
  const resetMs = quota?.resetAt ? new Date(quota.resetAt).getTime() : NaN;
  if (!windowMs || !Number.isFinite(resetMs)) return null;
  // A reset further away than one window means the key's name lies about its
  // window (or the data is odd): refuse to guess a start.
  if (resetMs - now > windowMs * 1.02) return null;
  const since = new Date(resetMs - windowMs).toISOString();
  return getConnectionTokenSplit(connId, rawApiKey, since, quotaModelLikePatterns(quotaKey));
}

/**
 * Connections of `provider` on which this key has used up its plan share.
 * @returns {Promise<{ blocked: Set<string>, details: string[] }>}
 */
export async function getPlanBlockedConnections(rawApiKey, provider) {
  const empty = { blocked: new Set(), details: [] };
  if (!rawApiKey) return empty;
  const record = await getApiKeyByKey(rawApiKey);
  const providerId = resolveProviderId(provider);
  const plan = record?.limits?.plan?.[providerId];
  if (!plan || !Object.keys(plan).length) return empty;

  const connections = await getProviderConnections({ provider: providerId, isActive: true });
  const blocked = new Set();
  const details = [];
  const now = Date.now();
  for (const conn of connections) {
    const quotas = await getConnectionQuotas(conn);
    if (!quotas) continue;
    for (const [name, maxPercent] of Object.entries(plan)) {
      const quota = quotas[name];
      if (!quota) continue;
      const split = await splitForQuota(conn.id, rawApiKey, name, quota, now);
      const pct = split ? estimateKeyPlanPercent(quota, split, now) : null;
      if (pct !== null && pct >= maxPercent) {
        blocked.add(conn.id);
        details.push(`${quota.displayName || name}: ${Math.round(pct * 10) / 10}%/${maxPercent}%`);
        log.warn("AUTH", `key-plan: key "${record.name || record.id}" over share on ${String(conn.id).slice(0, 8)} (${name} ${pct.toFixed(1)}%/${maxPercent}%)`);
        break;
      }
    }
  }
  return { blocked, details };
}

/**
 * Setup catalog for the dashboard: every active account's quotas that a share
 * can be set on, with the provider's utilization and (when a key is given) that
 * key's estimated share. One entry per provider, accounts nested.
 */
export async function getKeyPlanCatalog(record) {
  const connections = await getProviderConnections({ isActive: true });
  const now = Date.now();
  const rows = await Promise.all(connections.map(async (conn) => {
    const quotas = await getConnectionQuotas(conn);
    if (!quotas) return null;
    const entries = [];
    for (const [key, quota] of Object.entries(quotas)) {
      if (KEY_PLAN_EXCLUDED_QUOTA_RE.test(key) || !inferQuotaWindowMs(key)) continue;
      const usedPercent = quotaUsedPercent(quota);
      let keyPercent = null;
      if (record?.key) {
        const split = await splitForQuota(conn.id, record.key, key, quota, now);
        const est = split ? estimateKeyPlanPercent(quota, split, now) : null;
        keyPercent = est === null ? null : Math.round(est * 10) / 10;
      }
      entries.push({
        key,
        label: quota.displayName || key,
        usedPercent: usedPercent === null ? null : Math.round(usedPercent * 10) / 10,
        resetAt: quota.resetAt || null,
        keyPercent,
      });
    }
    if (!entries.length) return null;
    return { provider: conn.provider, connectionId: conn.id, account: conn.name || conn.email || conn.id.slice(0, 8), quotas: entries };
  }));
  return rows.filter(Boolean);
}
