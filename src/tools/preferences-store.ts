import type { HealthPreferences, HealthPreferencesStore } from "./registry.js";

interface PreferencesKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const DEFAULT_HEALTH_PREFERENCES: HealthPreferences = {
  dailyStepsGoal: 8_000,
  sleepHoursGoal: 8,
  hydrationMlGoal: 2_500,
  weeklyExerciseMinutesGoal: 150,
};

const PREFERENCE_FIELDS = Object.keys(
  DEFAULT_HEALTH_PREFERENCES,
) as (keyof HealthPreferences)[];

function validPreference(
  field: keyof HealthPreferences,
  value: unknown,
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return false;
  switch (field) {
    case "dailyStepsGoal":
      return Number.isInteger(value) && value <= 200_000;
    case "sleepHoursGoal":
      return value <= 24;
    case "hydrationMlGoal":
      return Number.isInteger(value) && value <= 100_000;
    case "weeklyExerciseMinutesGoal":
      return Number.isInteger(value) && value <= 10_080;
  }
}

function readJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createHealthPreferencesStore(
  kv: PreferencesKv,
  googleSubject: string,
): HealthPreferencesStore {
  const prefix = `health-preferences:${encodeURIComponent(googleSubject)}`;
  return {
    async read() {
      // Read the legacy combined value first, then let newer per-field keys win.
      const legacy = readJson(await kv.get(prefix));
      const fieldValues = await Promise.all(
        PREFERENCE_FIELDS.map(
          async (field) =>
            [
              field,
              readJson(await kv.get(`${prefix}:${field}`))["value"],
            ] as const,
        ),
      );
      const result = { ...DEFAULT_HEALTH_PREFERENCES };
      for (const field of PREFERENCE_FIELDS) {
        const oldValue = legacy[field];
        if (validPreference(field, oldValue)) result[field] = oldValue;
      }
      for (const [field, value] of fieldValues) {
        if (validPreference(field, value)) result[field] = value;
      }
      return result;
    },
    async update(set) {
      const current = await this.read();
      const entries = Object.entries(set) as [
        keyof HealthPreferences,
        number,
      ][];
      for (const [field, value] of entries) {
        if (!validPreference(field, value))
          throw new TypeError(`Invalid value for ${field}.`);
      }
      await Promise.all(
        // Separate keys prevent two edits to different goals from clobbering.
        entries
          .filter(([field, value]) => current[field] !== value)
          .map(([field, value]) =>
            kv.put(`${prefix}:${field}`, JSON.stringify({ value })),
          ),
      );
      return { ...current, ...set };
    },
  };
}
