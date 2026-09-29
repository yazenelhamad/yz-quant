import { describe, expect, it } from "vitest";
import { MAX_REJECTIONS_PER_CANDIDATE, REEVALUATE_AFTER_MS, evaluationSettled, isCircumstantialRejection } from "./cycle.js";

const now = new Date("2026-09-28T16:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ev = (finalStatus: string, evaluatedAt: string) => ({ finalStatus, detail: { evaluatedAt }, createdAt: ago(10 * 86_400_000) });
const base = { now, session: "regular", rejections: 1, trades: [] as { state: string }[] };

describe("evaluationSettled", () => {
  it("a fresh rejection stands; a cooled one is provisional and gets another look", () => {
    expect(evaluationSettled(ev("rejected", ago(REEVALUATE_AFTER_MS - 1000)), base)).toBe(true);
    expect(evaluationSettled(ev("rejected", ago(REEVALUATE_AFTER_MS + 1000)), base)).toBe(false);
  });

  it("uses the evaluation time in the detail, not the row's original creation time", () => {
    expect(evaluationSettled({ finalStatus: "rejected", detail: {}, createdAt: ago(REEVALUATE_AFTER_MS + 1000) }, base)).toBe(false);
    expect(evaluationSettled({ finalStatus: "rejected", detail: { evaluatedAt: ago(1000) }, createdAt: ago(REEVALUATE_AFTER_MS + 1000) }, base)).toBe(true);
  });

  it("bounds retries per candidate and never retries outside the regular session", () => {
    expect(evaluationSettled(ev("rejected", ago(REEVALUATE_AFTER_MS * 3)), { ...base, rejections: MAX_REJECTIONS_PER_CANDIDATE })).toBe(true);
    expect(evaluationSettled(ev("rejected", ago(REEVALUATE_AFTER_MS * 3)), { ...base, session: "closed" })).toBe(true);
  });

  it("an approval or shadow decision stands while its trade lives and reopens once every trade ended unfilled", () => {
    const old = ago(REEVALUATE_AFTER_MS * 2);
    expect(evaluationSettled(ev("shadow", old), { ...base, trades: [{ state: "monitoring" }] })).toBe(true);
    expect(evaluationSettled(ev("shadow", old), { ...base, trades: [{ state: "canceled" }, { state: "order_submitted" }] })).toBe(true);
    expect(evaluationSettled(ev("shadow", old), { ...base, trades: [{ state: "canceled" }] })).toBe(false);
    expect(evaluationSettled(ev("approved", old), { ...base, trades: [{ state: "rejected" }] })).toBe(false);
    expect(evaluationSettled(ev("shadow", ago(1000)), { ...base, trades: [{ state: "canceled" }] })).toBe(true);
    expect(evaluationSettled(ev("shadow", old), { ...base, trades: [] })).toBe(true); // no trade record: leave it
  });

  it("an account-state rejection (kill switch, pause, session) stands only while the account is blocked", () => {
    const ks = { finalStatus: "rejected", detail: { evaluatedAt: ago(1000), rejectionReasons: ["kill_switch", "account_paused"] }, createdAt: ago(1000) };
    expect(evaluationSettled(ks, { ...base, accountBlocked: true })).toBe(true);
    expect(evaluationSettled(ks, { ...base, accountBlocked: false })).toBe(false); // released: look again now, no cooldown
    expect(evaluationSettled(ks, { ...base, rejections: MAX_REJECTIONS_PER_CANDIDATE, accountBlocked: false })).toBe(false);
    expect(isCircumstantialRejection(["bad_risk_reward"])).toBe(false);
    expect(isCircumstantialRejection(["market_session"])).toBe(true);
  });

  it("waiting and needs_approval decisions are owned by their own flows", () => {
    const old = ago(REEVALUATE_AFTER_MS * 2);
    expect(evaluationSettled(ev("waiting", old), base)).toBe(true);
    expect(evaluationSettled(ev("needs_approval", old), base)).toBe(true);
  });
});
