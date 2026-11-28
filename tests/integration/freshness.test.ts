import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerDataFreshnessTool } from "../../src/tools/freshness.js";

function captureFreshness(api: { request: ReturnType<typeof vi.fn> }) {
  let handler: ((input: never) => Promise<unknown>) | undefined;
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      callback: (input: never) => Promise<unknown>,
    ) {
      if (name === "get_data_freshness") handler = callback;
    },
  } as unknown as McpServer;
  registerDataFreshnessTool(server, api as never);
  if (!handler) throw new Error("Freshness tool was not registered.");
  return handler;
}

describe("Google Health data freshness tool", () => {
  it("reports the newest returned measurement timestamp and source, not an upload-time claim", async () => {
    const now = new Date().toISOString();
    const request = vi.fn(async () => ({
      dataPoints: [
        {
          heartRate: { sampleTime: { physicalTime: now }, updateTime: now },
          dataSource: { platform: "GOOGLE_WEB_API" },
        },
      ],
    }));
    const handler = captureFreshness({ request });
    const response = (await handler({
      dataTypes: ["heart-rate"],
      lookbackDays: 7,
    } as never)) as {
      structuredContent: { data: Record<string, unknown> };
    };
    const data = response.structuredContent.data;
    expect(data.measurementTimeNote).toMatch(
      /not a guaranteed upload\/sync time/,
    );
    expect(data.dataTypes).toMatchObject([
      {
        dataType: "heart-rate",
        status: "record_found",
        measurementTime: now,
        dataSource: { platform: "GOOGLE_WEB_API" },
      },
    ]);
    expect(request).toHaveBeenCalledOnce();
  });

  it("follows a bounded number of pages and includes the current civil day", async () => {
    const now = new Date();
    const latest = new Date(now.getTime() - 60_000).toISOString();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        dataPoints: [{ heartRate: { sampleTime: { physicalTime: latest } } }],
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({
        dataPoints: [
          {
            heartRate: {
              sampleTime: {
                physicalTime: new Date(
                  now.getTime() - 2 * 60_000,
                ).toISOString(),
              },
            },
          },
        ],
      });
    const handler = captureFreshness({ request });
    const response = (await handler({
      dataTypes: ["heart-rate"],
      lookbackDays: 7,
    } as never)) as {
      structuredContent: { data: { dataTypes: Record<string, unknown>[] } };
    };

    expect(response.structuredContent.data.dataTypes[0]).toMatchObject({
      status: "record_found",
      measurementTime: latest,
      paginationTruncated: false,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0].query?.filter).toContain(
      `heart_rate.sample_time.physical_time < "${new Date().toISOString().slice(0, 19)}Z"`,
    );
    expect(request.mock.calls[1]?.[0].query?.pageToken).toBe("page-2");
  });

  it("reports daily measurements as civil dates rather than invented midnight timestamps", async () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const today = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
    const [year, month, day] = today.split("-").map(Number);
    const request = vi.fn(async (input: { methodId: string }) =>
      input.methodId === "health.users.getSettings"
        ? { timeZone: "Asia/Kolkata" }
        : {
            dataPoints: [
              {
                dailyRestingHeartRate: {
                  date: { year, month, day },
                  beatsPerMinute: "60",
                },
              },
            ],
          },
    );
    const handler = captureFreshness({ request });
    const response = (await handler({
      dataTypes: ["daily-resting-heart-rate"],
      lookbackDays: 7,
    } as never)) as {
      structuredContent: { data: { dataTypes: Record<string, unknown>[] } };
    };

    expect(response.structuredContent.data.dataTypes[0]).toMatchObject({
      status: "record_found",
      measurementCivilDate: today,
      ageDays: 0,
    });
    expect(response.structuredContent.data.dataTypes[0]).not.toHaveProperty(
      "ageHours",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("treats an omitted collection as an empty successful result and queries exercise through today's local date", async () => {
    const requests: { methodId: string; query?: { filter?: string } }[] = [];
    const request = vi.fn(async (input: (typeof requests)[number]) => {
      requests.push(input);
      if (input.methodId === "health.users.getSettings")
        return { timeZone: "Asia/Kolkata" };
      return {};
    });
    const handler = captureFreshness({ request });
    const response = (await handler({
      dataTypes: ["exercise"],
      lookbackDays: 7,
    } as never)) as {
      structuredContent: { data: { dataTypes: Record<string, unknown>[] } };
    };
    expect(response.structuredContent.data.dataTypes[0]).toMatchObject({
      status: "no_record_in_lookback",
      newestReturnedRecord: null,
    });
    const filter = requests[1]?.query?.filter ?? "";
    expect(filter).toMatch(/civil_start_time >= "\d{4}-\d{2}-\d{2}T00:00:00"/);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const today = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
    expect(filter).toContain(`civil_start_time < "${nextDay(today)}T00:00:00"`);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("queries sleep with bounded physical RFC 3339 session timestamps", async () => {
    const requests: {
      methodId: string;
      apiVersion?: string;
      query?: { filter?: string };
    }[] = [];
    const request = vi.fn(async (input: (typeof requests)[number]) => {
      requests.push(input);
      if (input.methodId === "health.users.getSettings")
        return { timeZone: "Asia/Kolkata" };
      return {
        dataPoints: [
          {
            sleep: {
              interval: {
                startTime: "2026-11-27T21:37:00Z",
                endTime: "2026-11-28T04:00:00Z",
              },
            },
          },
        ],
      };
    });
    const handler = captureFreshness({ request });
    const response = (await handler({
      dataTypes: ["sleep"],
      lookbackDays: 7,
    } as never)) as {
      structuredContent: { data: { dataTypes: Record<string, unknown>[] } };
    };
    expect(response.structuredContent.data.dataTypes[0]).toMatchObject({
      dataType: "sleep",
      status: "record_found",
      measurementTime: "2026-11-28T04:00:00Z",
    });
    expect(requests[0]?.query?.filter).toMatch(
      /^sleep\.interval\.end_time >= "\d{4}-\d{2}-\d{2}T.*Z" AND sleep\.interval\.end_time < "\d{4}-\d{2}-\d{2}T.*Z"$/,
    );
    expect(requests[0]?.apiVersion).toBe("v4");
    expect(request).toHaveBeenCalledOnce();
  });

  it("bounds ECG freshness by physical time and automatically selects beta for beta-only types", async () => {
    const requests: {
      methodId: string;
      apiVersion?: string;
      query?: { filter?: string };
    }[] = [];
    const request = vi.fn(async (input: (typeof requests)[number]) => {
      requests.push(input);
      return input.methodId === "health.users.getSettings"
        ? { timeZone: "Asia/Kolkata" }
        : {};
    });
    const handler = captureFreshness({ request });
    await handler({
      dataTypes: ["electrocardiogram", "skin-temperature-sensors"],
      lookbackDays: 7,
    } as never);
    const ecg = requests.find((item) =>
      item.query?.filter?.startsWith("electrocardiogram.interval.start_time"),
    );
    const beta = requests.find((item) =>
      item.query?.filter?.startsWith(
        "skin_temperature_sensors.sample_time.physical_time",
      ),
    );
    expect(ecg?.query?.filter).toContain(
      " AND electrocardiogram.interval.start_time < ",
    );
    expect(ecg?.apiVersion).toBe("v4");
    expect(beta?.apiVersion).toBe("v4beta");
  });
});

function nextDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
