#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createLocalTokenProvider,
  credentialsPath,
  loadLocalCredentials,
  runLocalAuthorization,
} from "./auth/local.js";
import { HealthApi } from "./google-health/client.js";
import { serveLocalStdio } from "./stdio.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const child = spawn(command, [url], {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
}

async function confirmLocalDataAccess(
  scopes: readonly string[],
): Promise<boolean> {
  const categoryLabels: Record<string, string> = {
    activity_and_fitness: "activity, steps, distance, calories and exercise",
    ecg: "electrocardiogram records",
    health_metrics_and_measurements:
      "heart rate, oxygen saturation and other body measurements",
    irn: "irregular rhythm notifications",
    location: "exercise route location",
    logged_symptoms: "logged symptoms",
    mindfulness: "mindfulness records",
    nutrition: "nutrition and hydration",
    profile: "account profile and paired devices",
    reproductive_health: "reproductive health",
    settings: "health account settings",
    sleep: "sleep sessions and stages",
  };
  const categories = [
    ...new Set(
      scopes.map((scope) => {
        const category = scope.split("googlehealth.")[1]?.split(".")[0];
        return (
          categoryLabels[category ?? ""] ?? category ?? "Google Health data"
        );
      }),
    ),
  ];
  process.stdout.write(
    [
      "Google Health data access disclosure",
      `This local server requests these Google Health data categories: ${categories.join("; ")}. Google's next consent screen lists the exact scopes.`,
      "When an MCP tool is called, requested health data is read from Google and returned to the connected MCP client (which may be an AI assistant and may process the data under its own terms).",
      "The server does not retain health response records; OAuth credentials are saved in a private file outside this project.",
      `Requested Google OAuth scopes: ${scopes.length}${scopes.some((scope) => scope.endsWith(".writeonly")) ? ", including supported write permissions" : ", read-only"}.`,
      "Google Health data will be used only for user-directed health and fitness features and handled under Google's Limited Use requirements.",
      "",
    ].join("\n") + "\n",
  );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      "Type AUTHORIZE to continue to Google sign-in: ",
    );
    return answer.trim() === "AUTHORIZE";
  } finally {
    prompt.close();
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "Google Health MCP local commands:",
      "  ghealth-mcp auth --client-secrets <OAuth-desktop-client.json> [--write] [--project-admin] [--credentials <path>]",
      "  ghealth-mcp doctor [--credentials <path>]",
      "  ghealth-mcp                 Start the MCP stdio server",
      "  ghealth-mcp serve [--credentials <path>]",
    ].join("\n") + "\n",
  );
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...options] = args;
  // MCP hosts launch the package without arguments; use stdio by default.
  if (!command) return serveLocalStdio();
  if (command === "--help" || command === "-h") return printHelp();
  if (
    options.some(
      (item) =>
        item.startsWith("--") &&
        ![
          "--client-secrets",
          "--credentials",
          "--write",
          "--project-admin",
        ].includes(item),
    )
  ) {
    throw new Error("Unknown option. Run with --help for usage.");
  }

  if (command === "auth") {
    const clientSecretsPath = option(options, "--client-secrets");
    if (!clientSecretsPath)
      throw new Error(
        "auth requires --client-secrets <OAuth-desktop-client.json>.",
      );
    const path = await runLocalAuthorization({
      clientSecretsPath: resolve(clientSecretsPath),
      ...(options.includes("--credentials")
        ? { credentialsOutputPath: resolve(option(options, "--credentials")!) }
        : {}),
      includeWrites: hasFlag(options, "--write"),
      includeProjectAdmin: hasFlag(options, "--project-admin"),
      openBrowser,
      confirmAccess: confirmLocalDataAccess,
    });
    process.stdout.write(
      `Google Health authorization saved locally at ${path}. Token values were not printed.\n`,
    );
    return;
  }

  const explicitCredentials = options.includes("--credentials")
    ? resolve(option(options, "--credentials")!)
    : undefined;
  if (command === "doctor") {
    const path = explicitCredentials ?? credentialsPath();
    const credentials = await loadLocalCredentials(path);
    const api = new HealthApi({
      tokenProvider: createLocalTokenProvider({ path }),
    });
    await api.request({
      methodId: "health.users.getIdentity",
      pathParams: { name: "users/me/identity" },
    });
    process.stdout.write(
      `Google Health authorization is valid. Granted Google Health scopes: ${credentials.scopes.length}. Credentials file: ${path}\n`,
    );
    return;
  }
  if (command === "serve") {
    if (explicitCredentials)
      process.env["GOOGLE_HEALTH_CREDENTIALS"] = explicitCredentials;
    serveLocalStdio();
    return;
  }
  throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected local command error.";
    process.stderr.write(`Google Health MCP: ${message}\n`);
    process.exitCode = 1;
  });
}
