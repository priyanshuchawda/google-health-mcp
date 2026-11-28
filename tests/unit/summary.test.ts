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

  it("reports available sleep stage minutes and primary sleep times", () => {
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
                startTime: "2026-11-25T22:00:00Z",
                endTime: "2026-11-26T02:00:00Z",
              },
              summary: { minutesAsleep: "180", minutesInSleepPeriod: "240" },
              metadata: { mainSleep: true },
              stages: [
                {
                  type: "LIGHT",
                  startTime: "2026-11-25T22:00:00Z",
                  endTime: "2026-11-25T23:00:00Z",
                },
                {
                  type: "DEEP",
                  startTime: "2026-11-25T23:00:00Z",
                  endTime: "2026-11-26T00:00:00Z",
                },
                {
                  type: "REM",
                  startTime: "2026-11-26T00:00:00Z",
                  endTime: "2026-11-26T01:00:00Z",
                },
                {
                  type: "AWAKE",
                  startTime: "2026-11-26T01:00:00Z",
                  endTime: "2026-11-26T02:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });

    expect(summary.metrics.sleepStagesMinutes).toEqual({
      deep: 60,
      light: 60,
      rem: 60,
      awake: 60,
      asleep: null,
      restless: null,
    });
    expect(summary.metrics.primarySleep).toEqual({
      startTime: "2026-11-25T22:00:00Z",
      endTime: "2026-11-26T02:00:00Z",
    });
  });

  it("does not classify a nap as primary sleep and preserves missing stages", () => {
    const summary = buildDailySummary({
      date: "2026-11-26",
      timeZone: "Asia/Kolkata",
      rollups: {},
      sleep: {
        dataPoints: [
          {
            name: "nap",
            sleep: {
              type: "CLASSIC",
              interval: {
                startTime: "2026-11-26T09:00:00Z",
                endTime: "2026-11-26T10:00:00Z",
              },
              summary: {
                minutesAsleep: "45",
                stagesSummary: [{ type: "ASLEEP", minutes: "45" }],
              },
              metadata: { nap: true },
            },
          },
        ],
      },
    });

    expect(summary.metrics.primarySleep).toBeNull();
    expect(summary.sleepSessions[0]).toMatchObject({
      nap: true,
      sleepType: "CLASSIC",
    });
    expect(summary.metrics.sleepStagesMinutes).toEqual({
      deep: null,
      light: null,
      rem: null,
      awake: null,
      asleep: 45,
      restless: null,
    });
  });

  it("prefers Google's computed classic stage summary over raw intervals", () => {
    const summary = buildDailySummary({
      date: "2026-11-26",
      timeZone: "UTC",
      rollups: {},
      sleep: {
        dataPoints: [
          {
            name: "classic-main",
            sleep: {
              type: "CLASSIC",
              interval: {
                startTime: "2026-11-25T22:00:00Z",
                endTime: "2026-11-26T06:00:00Z",
              },
              summary: {
                minutesAsleep: "420",
                stagesSummary: [
                  { type: "ASLEEP", minutes: "420" },
                  { type: "RESTLESS", minutes: "20" },
                ],
              },
              metadata: { mainSleep: true, nap: false },
              stages: [
                {
                  type: "ASLEEP",
                  startTime: "2026-11-25T22:00:00Z",
                  endTime: "2026-11-26T05:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });

    expect(summary.metrics.sleepStagesMinutes).toEqual({
      deep: null,
      light: null,
      rem: null,
      awake: null,
      asleep: 420,
      restless: 20,
    });
    expect(summary.metrics.primarySleep).toEqual({
      startTime: "2026-11-25T22:00:00Z",
      endTime: "2026-11-26T06:00:00Z",
    });
  });

  it("returns null for stage fallback when intervals overlap within a session", () => {
    const summary = buildDailySummary({
      date: "2026-11-26",
      timeZone: "UTC",
      rollups: {},
      sleep: {
        dataPoints: [
          {
            name: "sleep-with-overlapping-stages",
            sleep: {
              interval: {
                startTime: "2026-11-25T22:00:00Z",
                endTime: "2026-11-26T06:00:00Z",
              },
              stages: [
                {
                  type: "LIGHT",
                  startTime: "2026-11-25T22:00:00Z",
                  endTime: "2026-11-25T23:30:00Z",
                },
                {
                  type: "DEEP",
                  startTime: "2026-11-25T23:00:00Z",
                  endTime: "2026-11-26T00:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });

    expect(summary.metrics.sleepStagesMinutes.deep).toBeNull();
    expect(summary.metrics.sleepStagesMinutes.light).toBeNull();
  });

  it("does not infer primary sleep from a session explicitly marked not-main", () => {
    const summary = buildDailySummary({
      date: "2026-11-26",
      timeZone: "UTC",
      rollups: {},
      sleep: {
        dataPoints: [
          {
            name: "not-main",
            sleep: {
              interval: {
                startTime: "2026-11-25T22:00:00Z",
                endTime: "2026-11-26T06:00:00Z",
              },
              summary: { minutesAsleep: "420" },
              metadata: { mainSleep: false, nap: false },
            },
          },
        ],
      },
    });

    expect(summary.metrics.primarySleep).toBeNull();
  });

  it("does not sum sleep durations when the session end precedes its start", () => {
    const summary = buildDailySummary({
      date: "2026-11-26",
      timeZone: "UTC",
      rollups: {},
      sleep: {
        dataPoints: [
          {
            name: "invalid-interval",
            sleep: {
              interval: {
                startTime: "2026-11-26T06:00:00Z",
                endTime: "2026-11-25T22:00:00Z",
              },
              summary: {
                minutesAsleep: "420",
                minutesInSleepPeriod: "480",
              },
            },
          },
        ],
      },
    });

    expect(summary.metrics.sleepMinutesAsleep).toBeNull();
    expect(summary.metrics.sleepMinutesInBed).toBeNull();
  });
});
