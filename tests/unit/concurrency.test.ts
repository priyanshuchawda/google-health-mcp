import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/tools/concurrency.js";

describe("mapWithConcurrency", () => {
  it("bounds simultaneously active jobs and retains input order", async () => {
    let active = 0;
    let maximum = 0;
    const values = await mapWithConcurrency(
      [30, 5, 20, 1, 10],
      2,
      async (delay) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, delay));
        active -= 1;
        return delay * 2;
      },
    );
    expect(maximum).toBe(2);
    expect(values).toEqual([60, 10, 40, 2, 20]);
  });

  it("rejects an invalid concurrency limit", async () => {
    await expect(mapWithConcurrency([], 0, async () => 1)).rejects.toThrow(
      /positive integer/,
    );
  });
});
