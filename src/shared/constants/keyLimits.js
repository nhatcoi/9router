// Per-API-key token limits: shared constants.
//
// Windows are ROLLING (the last N ms of usageHistory), so there is no reset
// state to persist or get out of sync. A key's limit for a window is either an
// absolute token count or a percentage of a pool the operator configures once
// per window in settings (`keyLimitPools`).

export const KEY_LIMIT_WINDOWS = Object.freeze({
  "5h": { label: "5 hours", ms: 5 * 60 * 60 * 1000 },
  day: { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  week: { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  month: { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
});

export const KEY_LIMIT_WINDOW_IDS = Object.freeze(Object.keys(KEY_LIMIT_WINDOWS));
export const KEY_LIMIT_MODES = Object.freeze(["tokens", "percent"]);

// Upper bounds, rejected (400) rather than clamped.
export const KEY_LIMIT_MAX_TOKENS = 1e12;
export const KEY_LIMIT_MAX_PERCENT = 100;

export const KEY_LIMITS_NONE = Object.freeze({});

export function keyLimitExceededMessage(windowId, used, max) {
  const label = KEY_LIMIT_WINDOWS[windowId]?.label || windowId;
  return `API key token limit reached for the last ${label} (${used}/${max} tokens)`;
}

// Plan share: a key's cut of a PROVIDER quota window (the rows on the Provider
// Limits cards: Claude "session (5h)" / "weekly (7d)", Antigravity
// gemini_session / claude_gpt_weekly, Codex session / weekly, ...). Stored as
// limits.plan = { "<provider>": { "<quota key>": percent } }. Quota keys differ
// per provider, so the window length is inferred from the key itself.
export const KEY_PLAN_PROVIDER_RE = /^[a-z0-9_.-]{1,40}$/i;
export const KEY_PLAN_QUOTA_KEY_RE = /^[\w .&()\-]{1,60}$/;

/** Window length of a provider quota key, or null when it cannot be told. */
export function inferQuotaWindowMs(key) {
  const k = String(key || "").toLowerCase();
  const h = /(\d{1,3})\s*h\b/.exec(k);
  if (h) return Number(h[1]) * 3600e3;
  const d = /(\d{1,3})\s*d\b/.exec(k);
  if (d) return Number(d[1]) * 86400e3;
  if (/week/.test(k)) return 7 * 86400e3;
  if (/session|five.?hour/.test(k)) return 5 * 3600e3;
  if (/daily/.test(k)) return 86400e3;
  if (/month/.test(k)) return 30 * 86400e3;
  return null;
}

/**
 * Quota families that share one provider window but are billed per model
 * group (Antigravity: Gemini vs Claude & GPT). Returns SQL LIKE patterns for
 * the models counted against that quota, or null = every model on the account.
 */
export function quotaModelLikePatterns(key) {
  const k = String(key || "").toLowerCase();
  if (k.startsWith("gemini")) return ["%gemini%"];
  if (k.startsWith("claude_gpt")) return ["%claude%", "%gpt%"];
  if (k.startsWith("spark")) return ["%spark%"];
  return null;
}

// Quotas that cannot be attributed to this key's chat traffic.
export const KEY_PLAN_EXCLUDED_QUOTA_RE = /review/i;
