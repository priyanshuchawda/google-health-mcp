import { spawn } from "node:child_process";
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

function printHelp(): void {
  process.stdout.write(
    [
      "Google Health MCP local commands:",
      "  npm run auth -- --client-secrets <OAuth-desktop-client.json> [--write] [--project-admin] [--credentials <path>]",
      "  npm run serve -- [--credentials <path>]",
      "  npm run doctor -- [--credentials <path>]",
    ].join("\n") + "\n",
  );
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...options] = args;
  if (!command || command === "--help" || command === "-h") return printHelp();
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
