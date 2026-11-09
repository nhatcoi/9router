"use client";

// Per-API-key token limits on the Endpoint page.
// One row per rolling window (5h / 24h / 7d / 30d): off, an absolute token cap,
// or a % of the pool set for that window (see KeyLimitPools). Shows live usage.
import { useState, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import { KEY_LIMIT_WINDOWS, KEY_LIMIT_WINDOW_IDS } from "@/shared/constants/keyLimits.js";

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export default function KeyLimitControls({ apiKey, pools, onSave }) {
  const limits = apiKey.limits || {};
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const [quota, setQuota] = useState([]);
  const [error, setError] = useState("");
  const [accounts, setAccounts] = useState(null); // plan catalog: null = loading

  const loadQuota = useCallback(async () => {
    try {
      const res = await fetch(`/api/keys/${apiKey.id}/quota`);
      if (res.ok) setQuota((await res.json()).quota || []);
    } catch {}
  }, [apiKey.id]);

  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch(`/api/keys/plan-catalog?keyId=${encodeURIComponent(apiKey.id)}`);
      setAccounts(res.ok ? (await res.json()).accounts || [] : []);
    } catch { setAccounts([]); }
  }, [apiKey.id]);

  // provider -> { quotaKey -> { label, accounts: [{account, usedPercent, keyPercent, resetAt}] } }
  // plus any saved share whose account is not connected right now.
  const planRows = useMemo(() => {
    const out = {};
    for (const a of accounts || []) {
      const group = (out[a.provider] ||= {});
      for (const q of a.quotas) {
        const row = (group[q.key] ||= { label: q.label, accounts: [] });
        row.accounts.push({ account: a.account, usedPercent: q.usedPercent, keyPercent: q.keyPercent, resetAt: q.resetAt });
      }
    }
    for (const [provider, quotas] of Object.entries(limits.plan || {})) {
      for (const k of Object.keys(quotas)) ((out[provider] ||= {})[k] ||= { label: k, accounts: [] });
    }
    return out;
  }, [accounts, limits.plan]);

  const toggle = () => {
    if (!open) {
      setDraft({
        ...Object.fromEntries(KEY_LIMIT_WINDOW_IDS.map((w) => [w, limits[w] ? { ...limits[w] } : { mode: "off", value: "" }])),
        plan: JSON.parse(JSON.stringify(limits.plan || {})),
      });
      loadCatalog();
      loadQuota();
    }
    setOpen(!open);
  };

  const setRow = (w, patch) => setDraft((d) => ({ ...d, [w]: { ...d[w], ...patch } }));

  const save = async () => {
    const payload = {};
    for (const w of KEY_LIMIT_WINDOW_IDS) {
      const row = draft[w];
      if (!row || row.mode === "off" || row.value === "" || row.value === undefined) { payload[w] = null; continue; }
      payload[w] = { mode: row.mode, value: Number(row.value) };
    }
    payload.plan = {};
    for (const [provider, quotas] of Object.entries(draft.plan || {})) {
      payload.plan[provider] = {};
      for (const [k, v] of Object.entries(quotas)) payload.plan[provider][k] = v === "" || v === undefined || v === null ? null : Number(v);
    }
    const err = await onSave(payload);
    setError(err || "");
    if (!err) { loadQuota(); loadCatalog(); }
  };

  const activeCount = Object.keys(limits).filter((k) => k !== "plan").length + Object.values(limits.plan || {}).reduce((n, q) => n + Object.keys(q).length, 0);
  return (
    <div className="mt-2" data-testid="key-limits">
      <button onClick={toggle} className="flex items-center gap-1 text-xs font-medium text-primary">
        <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>{open ? "expand_less" : "speed"}</span>
        Limits: 5h / weekly plan share, tokens{activeCount ? ` (${activeCount})` : ""}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {KEY_LIMIT_WINDOW_IDS.map((w) => {
            const row = draft[w] || { mode: "off", value: "" };
            const q = quota.find((x) => x.window === w);
            const pct = q?.percentUsed;
            return (
              <div key={w} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-16 text-text-muted">{KEY_LIMIT_WINDOWS[w].label}</span>
                <select
                  value={row.mode}
                  onChange={(e) => setRow(w, { mode: e.target.value })}
                  className="rounded border border-black/10 bg-transparent px-1 py-0.5 dark:border-white/10"
                >
                  <option value="off">No limit</option>
                  <option value="tokens">Tokens</option>
                  <option value="percent" disabled={!(pools?.[w] > 0)}>% of pool{pools?.[w] > 0 ? ` (${fmt(pools[w])})` : " (set pool first)"}</option>
                </select>
                {row.mode !== "off" && (
                  <input
                    type="number"
                    min="1"
                    max={row.mode === "percent" ? 100 : undefined}
                    value={row.value}
                    onChange={(e) => setRow(w, { value: e.target.value })}
                    className="w-28 rounded border border-black/10 bg-transparent px-1 py-0.5 dark:border-white/10"
                    placeholder={row.mode === "percent" ? "%" : "tokens"}
                  />
                )}
                {q && q.max !== null && (
                  <span className={pct >= 100 ? "text-red-500" : "text-text-muted"}>
                    {fmt(q.used)} / {fmt(q.max)} ({pct}%)
                  </span>
                )}
              </div>
            );
          })}
          <div className="mt-1 border-t border-black/5 pt-1.5 dark:border-white/5" data-testid="key-plan-share">
            <p className="mb-1 font-medium text-text-main">Share of provider plan</p>
            <p className="mb-1 text-text-muted">% of each plan window (5h / weekly) this key may use, per provider. Estimated from this key&apos;s share of the tokens sent through each account. Empty = no limit.</p>
            {accounts === null && <p className="text-text-muted">Loading connected accounts…</p>}
            {accounts !== null && Object.keys(planRows).length === 0 && (
              <p className="text-orange-500">No connected account reports quota windows. Connect one under Providers.</p>
            )}
            {Object.entries(planRows).map(([provider, quotas]) => (
              <div key={provider} className="mb-1.5">
                <p className="font-mono font-medium text-text-main">{provider}</p>
                {Object.entries(quotas).map(([qKey, row]) => (
                  <div key={qKey} className="flex flex-wrap items-center gap-2 py-0.5 pl-2">
                    <span className="w-40 truncate text-text-muted" title={qKey}>{row.label}</span>
                    <input
                      type="number" min="1" max="100"
                      value={draft.plan?.[provider]?.[qKey] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, plan: { ...d.plan, [provider]: { ...(d.plan?.[provider] || {}), [qKey]: e.target.value } } }))}
                      className="w-20 rounded border border-black/10 bg-transparent px-1 py-0.5 dark:border-white/10"
                      placeholder="% (off)"
                    />
                    <span className="text-text-muted">%</span>
                    {row.accounts.map((a) => (
                      <span key={a.account} className="text-text-muted">
                        {a.account}: plan {a.usedPercent ?? "?"}% used{a.keyPercent !== null ? ` · this key ≈ ${a.keyPercent}%` : ""}
                      </span>
                    ))}
                    {row.accounts.length === 0 && <span className="text-orange-500">account not connected</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={save} className="rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Save limits</button>
            {error && <span className="text-xs text-red-500">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

KeyLimitControls.propTypes = {
  apiKey: PropTypes.shape({ id: PropTypes.string.isRequired, limits: PropTypes.object }).isRequired,
  pools: PropTypes.object,
  onSave: PropTypes.func.isRequired,
};
