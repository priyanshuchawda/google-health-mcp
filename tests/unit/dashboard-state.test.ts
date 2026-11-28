import { describe, expect, it } from "vitest";
import {
  DashboardSubmissionGate,
  LatestRequest,
  latestRangeForRefresh,
  writeFeedback,
} from "../../src/ui/dashboard-state.js";

describe("dashboard state", () => {
  it("moves the rolling seven-day window forward after midnight in its timezone", () => {
    const before = latestRangeForRefresh(
      null,
      new Date("2026-11-28T18:29:59Z"),
      "Asia/Kolkata",
    );
    const after = latestRangeForRefresh(
      null,
      new Date("2026-11-28T18:30:01Z"),
      "Asia/Kolkata",
    );
    expect(before).toEqual({ startDate: "2026-11-22", endDate: "2026-11-28" });
    expect(after).toEqual({ startDate: "2026-11-23", endDate: "2026-11-29" });
  });

  it("keeps an explicitly selected custom range on refresh", () => {
    const selected = { startDate: "2026-10-01", endDate: "2026-10-15" };
    expect(
      latestRangeForRefresh(
        selected,
        new Date("2026-11-29T00:00:00Z"),
        "Asia/Kolkata",
      ),
    ).toEqual(selected);
  });

  it("blocks duplicate submissions until the first operation finishes", () => {
    const gate = new DashboardSubmissionGate();
    const release = gate.tryAcquire("hydration");
    expect(release).toBeTypeOf("function");
    expect(gate.tryAcquire("hydration")).toBeNull();
    expect(gate.tryAcquire("weight")).toBeTypeOf("function");
    release?.();
    expect(gate.tryAcquire("hydration")).toBeTypeOf("function");
  });

  it("marks only the latest overlapping refresh as current", () => {
    const requests = new LatestRequest();
    const oldRefresh = requests.begin();
    const newRefresh = requests.begin();
    expect(requests.isCurrent(oldRefresh)).toBe(false);
    expect(requests.isCurrent(newRefresh)).toBe(true);
  });

  it("treats only completed upstream operations as successful writes", () => {
    expect(writeFeedback({ status: "completed" }, "Saved.")).toEqual({
      outcome: "completed",
      message: "Saved.",
    });
    expect(writeFeedback({ status: "pending" }, "Saved.")).toMatchObject({
      outcome: "pending",
      message: expect.stringContaining("still pending"),
    });
    expect(
      writeFeedback({ status: "response_received_unconfirmed" }, "Saved."),
    ).toMatchObject({
      outcome: "unconfirmed",
      message: expect.stringContaining("without confirming completion"),
    });
    expect(writeFeedback({}, "Saved.").outcome).toBe("unconfirmed");
  });
});
