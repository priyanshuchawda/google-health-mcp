import { describe, expect, it } from "vitest";
import { buildDailySummary, nextCivilDate } from "../../src/tools/summaries.js";

describe("daily Google Health summary", () => {
  it("converts supported rollup units and keeps absent measurements null", () => {
    const summary = buildDailySummary({
      date: "2026-11-26",
      timeZone: "Asia/Kolkata",
      rollups: {
        steps: { rollupDataPoints: [{ steps: { countSum: "8372" } }] },
        distance: {
          rollupDataPoints: [{ distance: { millimetersSum: "6200000" } }],
        },
        "active-energy-burned": { rollupDataPoints: [] },
      },
      sleep: { dataPoints: [] },
    });

    expect(summary.date).toBe("2026-11-26");
    expect(summary.timeZone).toBe("Asia/Kolkata");
    expect(summary.metrics.steps).toEqual({ value: 8372, unit: "steps" });
    expect(summary.metrics.distance).toEqual({ value: 6200, unit: "m" });
    expect(summary.metrics.activeEnergy).toBeNull();
    expect(summary.metrics.sleepMinutesAsleep).toBeNull();
  });

  it("distinguishes actual sleep from time in bed and reports primary sleep separately", () => {
    const summary = buildDailySummary({
      date: "2026-11-26",
      timeZone: "Asia/Kolkata",
      rollups: {},
      sleep: {
        dataPoints: [
          {
            name: "users/me/dataTypes/sleep/dataPoints/main",
            sleep: {
              interval: {
                startTime: "2026-11-25T18:30:00Z",
                endTime: "2026-11-26T01:00:00Z",
              },
              summary: { minutesAsleep: "350", minutesInSleepPeriod: "390" },
              metadata: { mainSleep: true },
            },
          },
        ],
      },
    });

    expect(summary.metrics.sleepMinutesAsleep).toBe(350);
    expect(summary.metrics.sleepMinutesInBed).toBe(390);
    expect(summary.sleepSessions[0]?.mainSleep).toBe(true);
  });

  it("returns no summed sleep duration when sessions overlap", () => {
    const session = (name: string, startTime: string, endTime: string) => ({
      name,
      sleep: {
        interval: { startTime, endTime },
        summary: { minutesAsleep: "60" },
      },
    });
    const summary = buildDailySummary({
      date: "2026-11-26",
      timeZone: "UTC",
      rollups: {},
      sleep: {
        dataPoints: [
          session("one", "2026-11-25T22:00:00Z", "2026-11-26T02:00:00Z"),
          session("two", "2026-11-26T01:00:00Z", "2026-11-26T03:00:00Z"),
        ],
      },
    });
    expect(summary.metrics.sleepMinutesAsleep).toBeNull();
    expect(summary.dataQuality.sleepDurationUnavailableReason).toMatch(
      /overlap/i,
    );
  });

  it("computes the next civil date across month and year boundaries", () => {
    expect(nextCivilDate("2026-11-30")).toBe("2026-12-01");
    expect(nextCivilDate("2026-12-31")).toBe("2027-01-01");
  });
});
