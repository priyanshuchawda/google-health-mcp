import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { HealthApi } from "../../src/google-health/client.js";
import { registerRecordTools } from "../../src/tools/records.js";

function captureTools(api: HealthApi) {
  const handlers = new Map<string, (input: never) => Promise<unknown>>();
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: (input: never) => Promise<unknown>,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerRecordTools(server, api);
  return handlers;
}

const validSleepRecord = {
  sleep: {
    interval: {
      startTime: "2026-11-26T22:00:00Z",
      startUtcOffset: "19800s",
      endTime: "2026-11-26T23:00:00Z",
      endUtcOffset: "19800s",
    },
  },
};

describe("record MCP handlers", () => {
  it.each([
    ["sleep", "sleep-1", validSleepRecord],
    [
      "weight",
      "weight-1",
      {
        weight: {
          sampleTime: {
            physicalTime: "2026-11-26T22:00:00Z",
            utcOffset: "19800s",
          },
          weightGrams: 70000,
        },
      },
    ],
    [
      "exercise",
      "exercise-1",
      {
        exercise: {
          interval: {
            startTime: "2026-11-26T22:00:00Z",
            startUtcOffset: "19800s",
            endTime: "2026-11-26T23:00:00Z",
            endUtcOffset: "19800s",
          },
          metricsSummary: {},
          exerciseType: "CIRCUIT_TRAINING",
          displayName: "Circuit training",
        },
      },
    ],
  ])(
    "validates and sends a %s PATCH through the actual handler",
    async (dataType, id, record) => {
      const fetchImpl = vi.fn(async () =>
        Response.json({ done: true, response: { name: "updated" } }),
      );
      const api = new HealthApi({
        tokenProvider: { getAccessToken: async () => "synthetic-token" },
        fetchImpl,
      });
      const handlers = captureTools(api);
      const update = handlers.get("update_health_record");
      expect(update).toBeDefined();
      const recordName = `users/me/dataTypes/${dataType}/dataPoints/${id}`;

      await expect(
        update!({ dataType, recordName, record } as never),
      ).resolves.toMatchObject({
        structuredContent: { data: { status: "completed" } },
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toBe(
        `https://health.googleapis.com/v4/${recordName}`,
      );
      expect(init?.method).toBe("PATCH");
    },
  );

  it("verifies a Google-returned user ID and normalizes it before PATCH", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return url.endsWith("/identity")
        ? Response.json({ healthUserId: "1234567890" })
        : Response.json({ done: true, response: { name: "updated" } });
    });
    const api = new HealthApi({
      tokenProvider: { getAccessToken: async () => "synthetic-token" },
      fetchImpl,
    });
    const update = captureTools(api).get("update_health_record")!;
    await update({
      dataType: "sleep",
      recordName: "users/1234567890/dataTypes/sleep/dataPoints/sleep-1",
      record: validSleepRecord,
    } as never);

    expect(urls).toEqual([
      "https://health.googleapis.com/v4/users/me/identity",
      "https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints/sleep-1",
    ]);
  });

  it("rejects a data point name belonging to another Google Health user", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ healthUserId: "1234567890" }),
    );
    const api = new HealthApi({
      tokenProvider: { getAccessToken: async () => "synthetic-token" },
      fetchImpl,
    });
    const update = captureTools(api).get("update_health_record")!;

    await expect(
      update({
        dataType: "sleep",
        recordName: "users/9999999999/dataTypes/sleep/dataPoints/sleep-1",
        record: validSleepRecord,
      } as never),
    ).rejects.toThrow(/authenticated Google Health account/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("automatically selects v4beta for beta-only skin-temperature readings", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ dataPoints: [] }));
    const api = new HealthApi({
      tokenProvider: { getAccessToken: async () => "synthetic-token" },
      fetchImpl,
    });
    const getData = captureTools(api).get("get_health_data")!;
    await getData({
      dataType: "skin-temperature-sensors",
      operation: "list",
    } as never);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://health.googleapis.com/v4beta/users/me/dataTypes/skin-temperature-sensors/dataPoints",
    );
    await expect(
      getData({
        dataType: "skin-temperature-sensors",
        operation: "list",
        apiVersion: "v4",
      } as never),
    ).rejects.toThrow(/documented only in v4beta/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("runs a synthetic create, read, update, and delete round trip through HealthApi and MCP handlers", async () => {
    const recordId = "synthetic-water-1";
    const googleName = `users/1234567890/dataTypes/hydration-log/dataPoints/${recordId}`;
    let record: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/identity"))
          return Response.json({ healthUserId: "1234567890" });
        if (method === "POST" && url.pathname.endsWith("/dataPoints")) {
          record = {
            ...(JSON.parse(String(init?.body)) as Record<string, unknown>),
            name: googleName,
          };
          return Response.json({ done: true, response: { ...record } });
        }
        if (url.pathname.endsWith(":batchDelete")) {
          const names = (JSON.parse(String(init?.body)) as { names: string[] })
            .names;
          if (names.some((name) => name.endsWith(`/${recordId}`)))
            record = undefined;
          return Response.json({ done: true, response: {} });
        }
        if (method === "PATCH") {
          if (!record)
            return Response.json({ error: "missing" }, { status: 404 });
          record = {
            ...record,
            ...(JSON.parse(String(init?.body)) as Record<string, unknown>),
            name: googleName,
          };
          return Response.json({ done: true, response: { ...record } });
        }
        if (url.pathname.endsWith(`/dataPoints/${recordId}`))
          return record
            ? Response.json(record)
            : Response.json({ error: "missing" }, { status: 404 });
        if (url.pathname.endsWith("/dataPoints"))
          return Response.json({ dataPoints: record ? [record] : [] });
        return Response.json(
          { error: "unhandled synthetic request" },
          { status: 404 },
        );
      },
    );
    const api = new HealthApi({
      tokenProvider: { getAccessToken: async () => "synthetic-token" },
      fetchImpl,
    });
    const tools = captureTools(api);
    const create = tools.get("create_health_record")!;
    const read = tools.get("get_health_data")!;
    const update = tools.get("update_health_record")!;
    const remove = tools.get("delete_health_records")!;
    const hydration = {
      hydrationLog: {
        interval: {
          startTime: "2026-11-27T10:00:00Z",
          startUtcOffset: "19800s",
          endTime: "2026-11-27T10:00:00Z",
          endUtcOffset: "19800s",
        },
        amountConsumed: { milliliters: 1 },
      },
    };

    await expect(
      create({ dataType: "hydration-log", record: hydration } as never),
    ).resolves.toMatchObject({
      structuredContent: { data: { status: "completed" } },
    });
    await expect(
      read({
        dataType: "hydration-log",
        operation: "get",
        recordName: googleName,
      } as never),
    ).resolves.toMatchObject({
      structuredContent: { data: { name: googleName } },
    });
    await update({
      dataType: "hydration-log",
      recordName: googleName,
      record: {
        hydrationLog: {
          ...hydration.hydrationLog,
          amountConsumed: { milliliters: 2 },
        },
      },
    } as never);
    expect(
      (record?.["hydrationLog"] as Record<string, unknown>)["amountConsumed"],
    ).toEqual({ milliliters: 2 });
    await remove({
      dataType: "hydration-log",
      recordNames: [googleName],
      confirm: true,
    } as never);
    await expect(
      read({ dataType: "hydration-log", operation: "list" } as never),
    ).resolves.toMatchObject({
      structuredContent: { data: { dataPoints: [] } },
    });
  });
});
