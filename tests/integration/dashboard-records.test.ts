import { describe, expect, it } from "vitest";
import { validateGoogleRequestBody } from "../../src/google-health/body-validation.js";
import {
  hydrationRecord,
  localRfc3339,
  nutritionRecord,
  sleepRecord,
  weightRecord,
} from "../../src/ui/record-payloads.js";

describe("dashboard quick-entry payloads", () => {
  const start = new Date("2026-11-28T04:00:00.000Z");
  const end = new Date("2026-11-28T04:30:00.000Z");
  const logged = new Date("2026-11-28T04:30:00.000Z");

  it.each([
    ["hydration-log", hydrationRecord(250, logged)],
    ["weight", weightRecord(62.5, logged)],
    ["sleep", sleepRecord(start, end)],
    ["nutrition-log", nutritionRecord("Oats", "BREAKFAST", 250, logged)],
  ] as const)(
    "creates a discovery-schema-valid manual %s record",
    (dataType, record) => {
      expect(() =>
        validateGoogleRequestBody(
          "health.users.dataTypes.dataPoints.create",
          "v4",
          { parent: `users/me/dataTypes/${dataType}` },
          record,
        ),
      ).not.toThrow();
    },
  );

  it("formats a workout input with the correct local offset and validates measurement boundaries", () => {
    expect(localRfc3339(start)).toMatch(
      /2026-11-28T\d{2}:\d{2}:00[+-]\d{2}:\d{2}/,
    );
    expect(() => hydrationRecord(0, logged)).toThrow(/Water amount/);
    expect(() => weightRecord(1001, logged)).toThrow(/Weight must/);
    expect(() => sleepRecord(end, start)).toThrow(/end time must follow/);
    expect(() => nutritionRecord(" ", "BREAKFAST", undefined, logged)).toThrow(
      /Food name/,
    );
  });
});
