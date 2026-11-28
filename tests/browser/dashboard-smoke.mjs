/* global window, document, console */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HEALTH_DASHBOARD_HTML } from "../../dist/src/ui/dashboard-resource.js";
import { chromium } from "playwright";

const fixture = {
  dateRange: {
    startDate: "2026-11-22",
    endDate: "2026-11-28",
    days: 7,
    timeZone: "Asia/Kolkata",
  },
  daily: [
    {
      date: "2026-11-28",
      metrics: {
        steps: { value: 1_200, unit: "steps" },
        sleepMinutesAsleep: { value: 420, unit: "min" },
        hydration: { value: 500, unit: "ml" },
        exerciseMinutes: { value: 10, unit: "min" },
      },
      sleepSessions: [
        {
          startTime: "2026-11-27T17:45:00Z",
          endTime: "2026-11-28T00:15:00Z",
          civilStartTime: {
            date: { year: 2026, month: 11, day: 27 },
            time: { hours: 23, minutes: 15, seconds: 0 },
          },
          civilEndTime: {
            date: { year: 2026, month: 11, day: 28 },
            time: { hours: 5, minutes: 45, seconds: 0 },
          },
          minutesAsleep: 390,
          mainSleep: true,
          nap: false,
          sleepType: "STAGES",
        },
      ],
      exerciseSessions: [
        {
          exerciseType: "CIRCUIT_TRAINING",
          displayName: "Circuit training",
          civilStartTime: {
            date: { year: 2026, month: 11, day: 28 },
            time: { hours: 11, minutes: 8, seconds: 0 },
          },
          activeMinutes: 30,
          caloriesKcal: null,
          distanceMeters: null,
        },
      ],
      dataQuality: { unavailableMetrics: [] },
    },
  ],
  totals: { exerciseMinutes: { value: 95, unit: "min" } },
  sleepTimingConsistency: {
    bedtime: { averageLocalTime: "23:15", circularStdDevMinutes: 20 },
    wakeTime: { averageLocalTime: "05:45", circularStdDevMinutes: 30 },
  },
};

const hostShim = `
  window.__toolCalls = [];
  window.__hostMessages = [];
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    window.__hostMessages.push({ method: message.method, id: message.id });
    const respond = (result) => window.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
    if (message.method === "ui/initialize") {
      respond({
        protocolVersion: message.params.protocolVersion,
        hostInfo: { name: "Synthetic MCP Host", version: "1.0.0" },
        hostCapabilities: {},
        hostContext: { theme: "light", timeZone: "Asia/Kolkata", userAgent: "browser-test" }
      });
      return;
    }
    if (message.method === "ui/notifications/initialized") {
      window.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          content: [{ type: "text", text: "synthetic initial summary" }],
          structuredContent: { data: ${JSON.stringify(fixture)} },
        },
      }, "*");
      return;
    }
    if (message.method !== "tools/call") return;
    const name = message.params.name;
    window.__toolCalls.push({ name, args: message.params.arguments ?? {} });
    if (name === "create_health_record") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      respond({
        content: [{ type: "text", text: "synthetic uncertain write" }],
        isError: true,
      });
    } else if (name === "get_health_summary") {
      respond({ content: [{ type: "text", text: "synthetic summary" }], structuredContent: { data: ${JSON.stringify(fixture)} } });
    } else if (name === "get_data_freshness") {
      respond({ content: [{ type: "text", text: "synthetic freshness" }], structuredContent: { data: { dataTypes: [] } } });
    } else if (name === "settings.read") {
      respond({ content: [{ type: "text", text: "synthetic preferences" }], structuredContent: { data: { dailyStepsGoal: 8000, sleepHoursGoal: 8, hydrationMlGoal: 2500, weeklyExerciseMinutesGoal: 150 } } });
    } else if (name === "settings.update") {
      respond({ content: [{ type: "text", text: "synthetic preferences saved" }], structuredContent: { settings: message.params.arguments.set } });
    } else {
      respond({ content: [{ type: "text", text: "unexpected synthetic tool" }], isError: true });
    }
  });
`;

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(HEALTH_DASHBOARD_HTML);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No local test port.");

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "Asia/Kolkata",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(hostShim);
  await page.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(1500);
  const initialState = await page.evaluate(() => ({
    status: document.querySelector("#status")?.textContent,
    messages: window.__hostMessages,
    calls: window.__toolCalls,
    appJsPresent: [...document.scripts].some((script) =>
      script.textContent.includes("ui/initialize"),
    ),
  }));
  assert.ok(
    initialState.messages.some((message) => message.method === "ui/initialize"),
  );
  await page.waitForFunction(() =>
    window.__toolCalls.some((call) => call.name === "get_data_freshness"),
  );
  await page
    .getByRole("heading", { name: "Personal target progress" })
    .waitFor();
  assert.match(await page.locator("#view").innerText(), /1,200 \/ 8,000/);
  assert.match(await page.locator("#view").innerText(), /steps on 2026-11-28/);
  assert.doesNotMatch(await page.locator("#view").innerText(), /steps today/);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    "dashboard should fit a narrow mobile viewport",
  );

  await page.getByRole("button", { name: "Sleep", exact: true }).click();
  assert.match(await page.locator("#view").innerText(), /Usual bedtime 23:15/);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activityText = await page.locator("#view").innerText();
  assert.match(activityText, /Circuit training/);
  assert.match(activityText, /2026-11-28 11:08/);

  await page.getByRole("button", { name: "Log", exact: true }).click();
  const submitWasLocked = await page.evaluate(() => {
    window.confirm = () => true;
    const form = document.querySelector("#hydration-form");
    form.requestSubmit();
    const locked = form.querySelector('button[type="submit"]').disabled;
    form.requestSubmit();
    return locked;
  });
  assert.equal(submitWasLocked, true, "submit control locks immediately");
  await page.waitForFunction(
    () =>
      window.__toolCalls.filter((call) => call.name === "create_health_record")
        .length === 1,
  );
  await page.waitForTimeout(500);
  assert.match(
    await page.locator("#status").innerText(),
    /Check Google Health before retrying/,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__toolCalls.filter(
          (call) => call.name === "create_health_record",
        ).length,
    ),
    1,
    "double submit should issue exactly one write",
  );
  await page.getByRole("button", { name: "Goals", exact: true }).click();
  await page.locator('#goals-form input[name="hydrationMlGoal"]').fill("3000");
  await page.locator("#goals-form").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() =>
    window.__toolCalls.some((call) => call.name === "settings.update"),
  );
  const preferenceUpdate = await page.evaluate(() =>
    window.__toolCalls.find((call) => call.name === "settings.update"),
  );
  assert.deepEqual(preferenceUpdate.args.set, { hydrationMlGoal: 3000 });
  assert.deepEqual(pageErrors, []);
  console.log(
    "Dashboard browser smoke passed: mobile layout, historical labels, sleep/workout views, duplicate-submit lock, uncertain-write warning, and partial goal updates.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
