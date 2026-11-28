export interface DateRange {
  startDate: string;
  endDate: string;
}

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days));
  return `${shifted.getUTCFullYear().toString().padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function latestRangeForRefresh(
  selected: DateRange | null,
  now: Date,
  timeZone: string,
  days = 7,
): DateRange {
  // Preserve an explicitly chosen historical range; only the default window rolls.
  if (selected) return { ...selected };
  if (!Number.isInteger(days) || days < 1 || days > 31)
    throw new RangeError("Dashboard range must be between 1 and 31 days.");
  const endDate = dateInTimeZone(now, timeZone);
  return { startDate: shiftDate(endDate, 1 - days), endDate };
}

export class DashboardSubmissionGate {
  private readonly active = new Set<string>();

  tryAcquire(key: string): (() => void) | null {
    if (this.active.has(key)) return null;
    this.active.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(key);
    };
  }
}

export class LatestRequest {
  private current = 0;

  begin(): number {
    // A newer request invalidates every earlier in-flight response.
    this.current += 1;
    return this.current;
  }

  isCurrent(request: number): boolean {
    return request === this.current;
  }
}
