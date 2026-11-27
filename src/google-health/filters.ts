import type { HealthDataType } from "./capabilities.js";

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CIVIL = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function validCalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day
  );
}

function validRfc3339(value: string): boolean {
  if (!RFC3339.test(value) || !validCalendarDate(value)) return false;
  const dateTime = value.slice(11, 19).split(":").map(Number);
  const hour = dateTime[0] ?? 99;
  const minute = dateTime[1] ?? 99;
  const second = dateTime[2] ?? 99;
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (
    offset &&
    (Number(offset[2]) > 14 ||
      Number(offset[3]) > 59 ||
      (Number(offset[2]) === 14 && Number(offset[3]) > 0))
  )
    return false;
  return !Number.isNaN(Date.parse(value));
}

function validCivil(value: string): boolean {
  if (!CIVIL.test(value) || !validCalendarDate(value)) return false;
  if (DATE_ONLY.test(value)) return true;
  const match = value.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) return false;
  return (
    Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3]) <= 59
  );
}

function filterField(dataType: HealthDataType): {
  field: string;
  format: "date" | "civil" | "physical";
  supportsEnd: boolean;
} {
  const type = dataType.filterParameter;
  if (dataType.kind === "Food")
    throw new TypeError(
      `Google Health ${dataType.slug} does not support time filters.`,
    );
  if (dataType.kind === "Daily")
    return { field: `${type}.date`, format: "date", supportsEnd: true };
  if (dataType.kind === "Interval")
    return {
      field: `${type}.interval.start_time`,
      format: "physical",
      supportsEnd: true,
    };
  if (dataType.kind === "Sample")
    return {
      field: `${type}.sample_time.physical_time`,
      format: "physical",
      supportsEnd: true,
    };
  if (dataType.slug === "sleep")
    return {
      field: "sleep.interval.end_time",
      format: "physical",
      supportsEnd: true,
    };
  if (dataType.slug === "electrocardiogram")
    return {
      field: "electrocardiogram.interval.start_time",
      format: "physical",
      supportsEnd: false,
    };
  return {
    field: `${type}.interval.civil_start_time`,
    format: "civil",
    supportsEnd: true,
  };
}

export function buildDateFilter(
  dataType: HealthDataType,
  start?: string,
  end?: string,
): string | undefined {
  if (start === undefined && end === undefined) return undefined;
  const { field, format, supportsEnd } = filterField(dataType);
  if (end !== undefined && !supportsEnd)
    throw new TypeError(
      `Google Health ${dataType.slug} supports a start filter but not an end filter.`,
    );

  const isValid =
    format === "date"
      ? (value: string) => DATE_ONLY.test(value) && validCalendarDate(value)
      : format === "civil"
        ? validCivil
        : validRfc3339;
  if (start !== undefined && end !== undefined) {
    const startsAreSameKind =
      format === "physical"
        ? RFC3339.test(start) === RFC3339.test(end)
        : format === "civil"
          ? DATE_ONLY.test(start) === DATE_ONLY.test(end)
          : true;
    if (!startsAreSameKind)
      throw new TypeError(
        "Filter start and end must use the same date format.",
      );
  }
  if (
    (start !== undefined && !isValid(start)) ||
    (end !== undefined && !isValid(end))
  ) {
    const expected =
      format === "date"
        ? "YYYY-MM-DD"
        : format === "civil"
          ? "a local ISO 8601 date or datetime"
          : "a valid RFC 3339 timestamp with an explicit UTC offset";
    throw new TypeError(
      `Google Health ${dataType.slug} filter values must be ${expected}.`,
    );
  }
  if (start !== undefined && end !== undefined) {
    if (
      format === "physical"
        ? Date.parse(start) >= Date.parse(end)
        : start >= end
    ) {
      throw new TypeError("Filter start must be before filter end.");
    }
  }

  const clauses = [
    ...(start !== undefined ? [`${field} >= "${start}"`] : []),
    ...(end !== undefined ? [`${field} < "${end}"`] : []),
  ];
  return clauses.join(" AND ");
}
