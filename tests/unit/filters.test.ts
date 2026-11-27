import { describe, expect, it } from "vitest";
import { getCapability } from "../../src/google-health/capabilities.js";
import { buildDateFilter } from "../../src/google-health/filters.js";

describe("Google Health filter construction", () => {
  it("uses physical timestamp fields for interval and sample measurements", () => {
    expect(
      buildDateFilter(
        getCapability("steps")!,
        "2026-11-26T00:00:00Z",
        "2026-11-27T00:00:00Z",
      ),
    ).toBe(
      'steps.interval.start_time >= "2026-11-26T00:00:00Z" AND steps.interval.start_time < "2026-11-27T00:00:00Z"',
    );
    expect(
      buildDateFilter(
        getCapability("heart-rate")!,
        "2026-11-26T00:00:00Z",
        "2026-11-27T00:00:00Z",
      ),
    ).toBe(
      'heart_rate.sample_time.physical_time >= "2026-11-26T00:00:00Z" AND heart_rate.sample_time.physical_time < "2026-11-27T00:00:00Z"',
    );
  });

  it("uses civil dates for day summaries and civil session starts except sleep", () => {
    expect(
      buildDateFilter(
        getCapability("daily-resting-heart-rate")!,
        "2026-11-26",
        "2026-11-27",
      ),
    ).toBe(
      'daily_resting_heart_rate.date >= "2026-11-26" AND daily_resting_heart_rate.date < "2026-11-27"',
    );
    expect(
      buildDateFilter(
        getCapability("nutrition-log")!,
        "2026-11-26",
        "2026-11-27",
      ),
    ).toBe(
      'nutrition_log.interval.civil_start_time >= "2026-11-26" AND nutrition_log.interval.civil_start_time < "2026-11-27"',
    );
    expect(
      buildDateFilter(
        getCapability("sleep")!,
        "2026-11-26T00:00:00Z",
        "2026-11-27T00:00:00Z",
      ),
    ).toBe(
      'sleep.interval.end_time >= "2026-11-26T00:00:00Z" AND sleep.interval.end_time < "2026-11-27T00:00:00Z"',
    );
  });

  it("rejects invalid dates, mixed time formats, reversed ranges, and unsupported food filters", () => {
    const steps = getCapability("steps")!;
    expect(() =>
      buildDateFilter(steps, "2026-02-30T00:00:00Z", "2026-03-01T00:00:00Z"),
    ).toThrow(/valid RFC 3339/i);
    expect(() =>
      buildDateFilter(steps, "2026-11-26T00:00:00Z", "2026-11-26"),
    ).toThrow(/same date format/i);
    expect(() =>
      buildDateFilter(steps, "2026-11-27T00:00:00Z", "2026-11-26T00:00:00Z"),
    ).toThrow(/before/i);
    expect(() =>
      buildDateFilter(getCapability("food")!, "2026-11-26", "2026-11-27"),
    ).toThrow(/does not support time filters/i);
  });
});
