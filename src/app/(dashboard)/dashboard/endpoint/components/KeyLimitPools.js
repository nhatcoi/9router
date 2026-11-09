"use client";

// Token pools per rolling window: the 100% base for percent key limits
// (e.g. pool "week" = 50M tokens, key limit 20% => 10M tokens/week).
import { useState } from "react";
import PropTypes from "prop-types";
import { KEY_LIMIT_WINDOWS, KEY_LIMIT_WINDOW_IDS } from "@/shared/constants/keyLimits.js";

export default function KeyLimitPools({ pools, onSave }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState("");

  const toggle = () => {
    if (!open) setDraft(Object.fromEntries(KEY_LIMIT_WINDOW_IDS.map((w) => [w, pools?.[w] ?? ""])));
    setOpen(!open);
  };

  const save = async () => {
    const payload = {};
    for (const w of KEY_LIMIT_WINDOW_IDS) payload[w] = draft[w] === "" ? null : Number(draft[w]);
    setError((await onSave(payload)) || "");
  };

  return (
    <div className="mb-3 rounded-lg border border-black/5 p-2 dark:border-white/5" data-testid="key-limit-pools">
      <button onClick={toggle} className="flex items-center gap-1 text-xs font-medium text-text-main">
        <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>{open ? "expand_less" : "donut_small"}</span>
        Token pools for % limits
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5 text-xs">
          <p className="text-text-muted">Total tokens available per rolling window. A key limit of 20% on &quot;7 days&quot; = 20% of this pool.</p>
          {KEY_LIMIT_WINDOW_IDS.map((w) => (
            <label key={w} className="flex items-center gap-2">
              <span className="w-16 text-text-muted">{KEY_LIMIT_WINDOWS[w].label}</span>
              <input
                type="number"
                min="0"
                value={draft[w] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [w]: e.target.value }))}
                className="w-36 rounded border border-black/10 bg-transparent px-1 py-0.5 dark:border-white/10"
                placeholder="tokens (empty = unset)"
              />
            </label>
          ))}
          <div className="flex items-center gap-2">
            <button onClick={save} className="rounded-xl border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary">Save pools</button>
            {error && <span className="text-red-500">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

KeyLimitPools.propTypes = { pools: PropTypes.object, onSave: PropTypes.func.isRequired };
