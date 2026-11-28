import { describe, expect, it } from "vitest";
import { createHealthPreferencesStore } from "../../src/tools/preferences-store.js";

function fakeKv() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("account-isolated health preferences", () => {
  it("preserves concurrent updates to different preferences", async () => {
    const kv = fakeKv();
    const store = createHealthPreferencesStore(kv, "google-user-1");
    await Promise.all([
      store.update({ dailyStepsGoal: 9_000 }),
      store.update({ sleepHoursGoal: 7.5 }),
    ]);
    await expect(store.read()).resolves.toMatchObject({
      dailyStepsGoal: 9_000,
      sleepHoursGoal: 7.5,
      hydrationMlGoal: 2_500,
      weeklyExerciseMinutesGoal: 150,
    });
  });

  it("keeps preferences isolated between Google subjects", async () => {
    const kv = fakeKv();
    const first = createHealthPreferencesStore(kv, "google-user-1");
    const second = createHealthPreferencesStore(kv, "google-user-2");
    await first.update({ dailyStepsGoal: 10_000 });
    await expect(second.read()).resolves.toMatchObject({
      dailyStepsGoal: 8_000,
    });
  });

  it("reads existing combined preferences and overlays per-field updates", async () => {
    const kv = fakeKv();
    kv.values.set(
      "health-preferences:google-user-1",
      JSON.stringify({ dailyStepsGoal: 7_000, hydrationMlGoal: 2_000 }),
    );
    const store = createHealthPreferencesStore(kv, "google-user-1");
    await store.update({ sleepHoursGoal: 7 });
    await expect(store.read()).resolves.toMatchObject({
      dailyStepsGoal: 7_000,
      sleepHoursGoal: 7,
      hydrationMlGoal: 2_000,
    });
  });
});
