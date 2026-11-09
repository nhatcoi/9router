import { describe, it, expect } from "vitest";
import {
  validateKeyLimitsInput,
  validateKeyLimitPools,
  keyLimitsFromColumn,
  keyLimitsToColumn,
  resolveLimitTokens,
} from "@/shared/utils/keyLimits.js";

describe("validateKeyLimitsInput", () => {
  it("accepts token and percent limits, drops null windows", () => {
    const r = validateKeyLimitsInput({ "5h": { mode: "tokens", value: 1000 }, week: { mode: "percent", value: 20 }, day: null }, { week: 5e6 });
    expect(r).toEqual({ ok: true, value: { "5h": { mode: "tokens", value: 1000 }, week: { mode: "percent", value: 20 } } });
  });
  it("rejects percent without a pool", () => {
    expect(validateKeyLimitsInput({ week: { mode: "percent", value: 20 } }, {}).ok).toBe(false);
  });
  it("rejects bad input", () => {
    expect(validateKeyLimitsInput({ hour: { mode: "tokens", value: 1 } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ "5h": { mode: "x", value: 1 } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ "5h": { mode: "tokens", value: -5 } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ "5h": { mode: "tokens", value: 1.5 } }).ok).toBe(false);
    expect(validateKeyLimitsInput({ week: { mode: "percent", value: 150 } }, { week: 1 }).ok).toBe(false);
    expect(validateKeyLimitsInput([]).ok).toBe(false);
  });
  it("null clears", () => {
    expect(validateKeyLimitsInput(null)).toEqual({ ok: true, value: {} });
  });
});

describe("pools / columns / resolve", () => {
  it("validates pools", () => {
    expect(validateKeyLimitPools({ week: 5000, "5h": null })).toEqual({ ok: true, value: { week: 5000 } });
    expect(validateKeyLimitPools({ week: -1 }).ok).toBe(false);
    expect(validateKeyLimitPools({ nope: 1 }).ok).toBe(false);
  });
  it("round-trips the column and fails open on corrupt JSON", () => {
    const limits = { "5h": { mode: "tokens", value: 10 } };
    expect(keyLimitsFromColumn(keyLimitsToColumn(limits))).toEqual(limits);
    expect(keyLimitsToColumn({})).toBeNull();
    expect(keyLimitsFromColumn("{bad")).toEqual({});
    expect(keyLimitsFromColumn(null)).toEqual({});
  });
  it("resolves absolute and percent caps", () => {
    expect(resolveLimitTokens({ mode: "tokens", value: 500 }, 0)).toBe(500);
    expect(resolveLimitTokens({ mode: "percent", value: 20 }, 1000)).toBe(200);
    expect(resolveLimitTokens({ mode: "percent", value: 20 }, 0)).toBeNull();
    expect(resolveLimitTokens(undefined, 10)).toBeNull();
  });
});
