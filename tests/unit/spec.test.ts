import { describe, expect, it } from "vitest";
import {
  apiMethods,
  assertOperationAllowed,
  defaultApiVersionForDataType,
  dataTypes,
  getApiMethod,
  getCapability,
  requiredScopesFor,
} from "../../src/google-health/capabilities.js";

describe("Google Health capability contract", () => {
  it("includes the documented data-type catalog and marks beta-only entries", () => {
    expect(dataTypes).toHaveLength(44);
    expect(new Set(dataTypes.map((type) => type.slug)).size).toBe(
      dataTypes.length,
    );
    expect(getCapability("skin-temperature-sensors")?.operations).toEqual([
      "list",
    ]);
    expect(getCapability("skin-temperature-sensors")?.beta).toBe(true);
    expect(defaultApiVersionForDataType("skin-temperature-sensors")).toBe(
      "v4beta",
    );
    expect(defaultApiVersionForDataType("steps")).toBe("v4");
    expect(getCapability("basal-energy-burned")).toBeUndefined();
    expect(getCapability("heart-rate")?.scopes).toContain(
      "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    );
  });

  it("allows supported operations and rejects unsupported writes", () => {
    expect(getCapability("sleep")?.operations).toContain("create");
    expect(() => assertOperationAllowed("steps", "create")).toThrow(
      /does not support create/i,
    );
    expect(() => assertOperationAllowed("unknown-type", "list")).toThrow(
      /unknown data type/i,
    );
  });

  it("returns only the scope class required by an operation", () => {
    expect(requiredScopesFor("sleep", "list")).toEqual([
      "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    ]);
    expect(requiredScopesFor("sleep", "create")).toEqual([
      "https://www.googleapis.com/auth/googlehealth.sleep.writeonly",
    ]);
  });

  it("contains the full user, data, webhook, device, and shared-link endpoint inventory", () => {
    const expected = [
      "health.users.getIdentity",
      "health.users.getIrnProfile",
      "health.users.getProfile",
      "health.users.updateProfile",
      "health.users.getSettings",
      "health.users.updateSettings",
      "health.users.pairedDevices.list",
      "health.users.dataTypes.dataPoints.dailyRollUp",
      "health.projects.subscribers.create",
      "health.projects.subscribers.subscriptions.patch",
      "health.shl.m.getShlManifest",
      "health.shl.r.get",
    ];
    for (const methodId of expected) {
      expect(getApiMethod(methodId, "v4")).toBeDefined();
    }
    expect(
      apiMethods.filter((method) => method.apiVersion === "v4"),
    ).toHaveLength(27);
    expect(
      new Set(apiMethods.map(({ apiVersion, id }) => `${apiVersion}:${id}`))
        .size,
    ).toBe(apiMethods.length);
    expect(apiMethods.some((method) => method.apiVersion === "v4beta")).toBe(
      true,
    );
    expect(
      apiMethods.some(
        (method) =>
          method.id === "health.shl.r.get" && method.apiVersion === "v4beta",
      ),
    ).toBe(true);
  });
});
