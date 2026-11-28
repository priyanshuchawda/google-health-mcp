type JsonObject = Record<string, unknown>;

function offsetSeconds(date: Date): string {
  return `${-date.getTimezoneOffset() * 60}s`;
}

function interval(start: Date, end: Date): JsonObject {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
    throw new TypeError("A valid start and end time are required.");
  if (end <= start)
    throw new TypeError("The end time must follow the start time.");
  return {
    startTime: start.toISOString(),
    startUtcOffset: offsetSeconds(start),
    endTime: end.toISOString(),
    endUtcOffset: offsetSeconds(end),
  };
}

const manualSource = { recordingMethod: "MANUAL" };

export function hydrationRecord(
  milliliters: number,
  loggedAt: Date,
): JsonObject {
  if (
    !Number.isFinite(milliliters) ||
    milliliters <= 0 ||
    milliliters > 100_000
  )
    throw new TypeError("Water amount must be from 1 to 100000 ml.");
  const start = new Date(loggedAt.getTime() - 60_000);
  return {
    dataSource: manualSource,
    hydrationLog: {
      amountConsumed: { milliliters, userProvidedUnit: "MILLILITER" },
      interval: interval(start, loggedAt),
    },
  };
}

export function weightRecord(kilograms: number, measuredAt: Date): JsonObject {
  if (!Number.isFinite(kilograms) || kilograms <= 0 || kilograms > 1_000)
    throw new TypeError("Weight must be from 0.1 to 1000 kg.");
  if (!Number.isFinite(measuredAt.getTime()))
    throw new TypeError("A valid measurement time is required.");
  return {
    dataSource: manualSource,
    weight: {
      sampleTime: {
        physicalTime: measuredAt.toISOString(),
        utcOffset: offsetSeconds(measuredAt),
      },
      weightGrams: Math.round(kilograms * 1_000),
    },
  };
}

export function sleepRecord(start: Date, end: Date): JsonObject {
  return {
    dataSource: manualSource,
    sleep: { type: "CLASSIC", interval: interval(start, end) },
  };
}

export function nutritionRecord(
  foodDisplayName: string,
  mealType: string,
  caloriesKcal: number | undefined,
  loggedAt: Date,
): JsonObject {
  const name = foodDisplayName.trim();
  if (!name || name.length > 200)
    throw new TypeError("Food name must contain 1 to 200 characters.");
  if (!["ANYTIME", "BREAKFAST", "LUNCH", "DINNER", "SNACK"].includes(mealType))
    throw new TypeError("Select a supported meal type.");
  if (
    caloriesKcal !== undefined &&
    (!Number.isFinite(caloriesKcal) ||
      caloriesKcal < 0 ||
      caloriesKcal > 100_000)
  )
    throw new TypeError("Calories must be from 0 to 100000 kcal.");
  const start = new Date(loggedAt.getTime() - 60_000);
  return {
    dataSource: manualSource,
    nutritionLog: {
      foodDisplayName: name,
      mealType,
      ...(caloriesKcal === undefined
        ? {}
        : {
            energy: {
              kcal: caloriesKcal,
              userProvidedUnit: "KILOCALORIE",
            },
          }),
      interval: interval(start, loggedAt),
    },
  };
}

export function localRfc3339(date: Date): string {
  if (!Number.isFinite(date.getTime()))
    throw new TypeError("A valid workout time is required.");
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  const sign = date.getTimezoneOffset() <= 0 ? "+" : "-";
  const absolute = Math.abs(date.getTimezoneOffset());
  return `${local.toISOString().slice(0, 19)}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
