// Per-API-key token limits for the /v1/* inference keys.
//
// A key may carry limits on rolling windows (5h / day / week / month), each an
// absolute token count or a percentage of the pool configured for that window
// in settings.keyLimitPools. Usage is summed from usageHistory. The check runs
// before any credential lookup, so a blocked request never touches a provider.
//
// Keys without limits (and requests without a recognised key) are unaffected.
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getKeyTokensSince } from "@/lib/db/repos/usageRepo.js";
import { extractClientApiKey } from "./keyAccess.js";
import { KEY_LIMIT_WINDOWS, KEY_LIMIT_WINDOW_IDS, keyLimitExceededMessage } from "@/shared/constants/keyLimits.js";
import { resolveLimitTokens } from "@/shared/utils/keyLimits.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

/**
 * Usage vs. limit for every window the key has a limit on.
 * @returns {Promise<Array<{window:string, used:number, max:number|null, percentUsed:number|null, mode:string, value:number}>>}
 */
export async function getKeyQuotaStatus(record, settings, now = Date.now()) {
  const limits = record?.limits || {};
  const pools = settings?.keyLimitPools || {};
  const out = [];
  for (const windowId of KEY_LIMIT_WINDOW_IDS) {
    const limit = limits[windowId];
    if (!limit) continue;
    const since = new Date(now - KEY_LIMIT_WINDOWS[windowId].ms).toISOString();
    const used = await getKeyTokensSince(record.key, since);
    const max = resolveLimitTokens(limit, pools[windowId]);
    out.push({
      window: windowId,
      mode: limit.mode,
      value: limit.value,
      used,
      max,
      percentUsed: max ? Math.round((used / max) * 1000) / 10 : null,
    });
  }
  return out;
}

/**
 * Gate for the request's key.
 * @returns {Promise<Response|null>} a 429 Response when any window is exhausted, else null.
 */
export async function enforceKeyQuota(request) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return null;
  const record = await getApiKeyByKey(apiKey);
  if (!record || !Object.keys(record.limits || {}).length) return null;

  const settings = await getSettings();
  for (const status of await getKeyQuotaStatus(record, settings)) {
    if (status.max === null) {
      // Percent limit whose pool was cleared afterwards: cannot be enforced.
      log.warn("AUTH", `key-quota: key "${record.name || record.id}" has a percent limit on "${status.window}" but no pool is set; skipped`);
      continue;
    }
    if (status.used >= status.max) {
      log.warn("AUTH", `key-quota: key "${record.name || record.id}" blocked on "${status.window}" (${status.used}/${status.max})`);
      return errorResponse(HTTP_STATUS.RATE_LIMITED, keyLimitExceededMessage(status.window, status.used, status.max));
    }
  }
  return null;
}
