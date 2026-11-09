// Per-API-key token limits: pure helpers (no DB, no request objects).
import {
  KEY_LIMIT_WINDOW_IDS,
  KEY_LIMIT_MODES,
  KEY_LIMIT_MAX_TOKENS,
  KEY_LIMIT_MAX_PERCENT,
  KEY_PLAN_PROVIDER_RE,
  KEY_PLAN_QUOTA_KEY_RE,
  inferQuotaWindowMs,
} from "@/shared/constants/keyLimits.js";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate client input: { "5h": { mode: "tokens"|"percent", value: number }, ... }.
 * A window set to null / omitted means "no limit for that window".
 * Rejects rather than repairs. `pools` (settings.keyLimitPools) is needed to
 * accept percent limits: a percent of an unset pool cannot be enforced.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateKeyLimitsInput(input, pools = {}) {
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (!isPlainObject(input)) return { ok: false, error: "limits must be an object" };
  const out = {};
  for (const [windowId, limit] of Object.entries(input)) {
    if (windowId === "plan") {
      if (limit === null || limit === undefined) continue;
      if (!isPlainObject(limit)) return { ok: false, error: "limits.plan must be an object" };
      const plan = {};
      for (const [provider, quotas] of Object.entries(limit)) {
        if (!KEY_PLAN_PROVIDER_RE.test(provider)) return { ok: false, error: `limits.plan: invalid provider "${provider}"` };
        if (quotas === null || quotas === undefined) continue;
        if (!isPlainObject(quotas)) return { ok: false, error: `limits.plan.${provider} must be an object` };
        const perProvider = {};
        for (const [name, raw] of Object.entries(quotas)) {
          if (!KEY_PLAN_QUOTA_KEY_RE.test(name)) return { ok: false, error: `limits.plan.${provider}: invalid quota "${name}"` };
          if (raw === null || raw === undefined) continue;
          if (!inferQuotaWindowMs(name)) return { ok: false, error: `limits.plan.${provider}: cannot tell the window of "${name}"` };
          const pct = Number(raw);
          if (!Number.isFinite(pct) || pct <= 0 || pct > KEY_LIMIT_MAX_PERCENT) return { ok: false, error: `limits.plan.${provider}["${name}"] must be a percent in (0, ${KEY_LIMIT_MAX_PERCENT}]` };
          perProvider[name] = pct;
        }
        if (Object.keys(perProvider).length) plan[provider] = perProvider;
      }
      if (Object.keys(plan).length) out.plan = plan;
      continue;
    }
    if (!KEY_LIMIT_WINDOW_IDS.includes(windowId)) return { ok: false, error: `unknown limit window "${windowId}"` };
    if (limit === null || limit === undefined) continue;
    if (!isPlainObject(limit)) return { ok: false, error: `limits.${windowId} must be an object` };
    if (!KEY_LIMIT_MODES.includes(limit.mode)) return { ok: false, error: `limits.${windowId}.mode must be "tokens" or "percent"` };
    const value = Number(limit.value);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: `limits.${windowId}.value must be a positive number` };
    if (limit.mode === "tokens") {
      if (!Number.isInteger(value) || value > KEY_LIMIT_MAX_TOKENS) return { ok: false, error: `limits.${windowId}.value must be an integer <= ${KEY_LIMIT_MAX_TOKENS}` };
    } else {
      if (value > KEY_LIMIT_MAX_PERCENT) return { ok: false, error: `limits.${windowId}.value must be <= ${KEY_LIMIT_MAX_PERCENT}` };
      if (!(Number(pools?.[windowId]) > 0)) return { ok: false, error: `set a token pool for "${windowId}" before using a percent limit` };
    }
    out[windowId] = { mode: limit.mode, value };
  }
  return { ok: true, value: out };
}

/** Validate settings.keyLimitPools: { "5h": tokens, ... }; null/0 clears a pool. */
export function validateKeyLimitPools(input) {
  if (!isPlainObject(input)) return { ok: false, error: "keyLimitPools must be an object" };
  const out = {};
  for (const [windowId, raw] of Object.entries(input)) {
    if (!KEY_LIMIT_WINDOW_IDS.includes(windowId)) return { ok: false, error: `unknown pool window "${windowId}"` };
    if (raw === null || raw === undefined || raw === 0 || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > KEY_LIMIT_MAX_TOKENS) return { ok: false, error: `keyLimitPools.${windowId} must be a non-negative integer <= ${KEY_LIMIT_MAX_TOKENS}` };
    out[windowId] = n;
  }
  return { ok: true, value: out };
}

/** Parse the `limits` TEXT column. Corrupt JSON reads as "no limits" (never throws). */
export function keyLimitsFromColumn(col) {
  if (typeof col !== "string" || !col) return {};
  try {
    const parsed = JSON.parse(col);
    const checked = validateKeyLimitsInput(parsed, new Proxy({}, { get: () => 1 }));
    return checked.ok ? checked.value : {};
  } catch {
    return {};
  }
}

export function keyLimitsToColumn(limits) {
  return limits && Object.keys(limits).length ? JSON.stringify(limits) : null;
}

/** Absolute token cap for one window's limit, or null when it cannot be enforced. */
export function resolveLimitTokens(limit, pool) {
  if (!limit) return null;
  if (limit.mode === "tokens") return Math.floor(limit.value);
  const p = Number(pool);
  if (!(p > 0)) return null;
  return Math.floor((p * limit.value) / 100);
}
