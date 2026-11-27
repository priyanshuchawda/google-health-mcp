import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLocalTokenProvider, credentialsPath } from "./auth/local.js";
import { createHealthMcpServer } from "./server.js";

export function serveLocalStdio(): void {
  const tokenProvider = createLocalTokenProvider({ path: credentialsPath() });
  const projectNumber = process.env["GOOGLE_HEALTH_PROJECT_NUMBER"];
  const projectAdminToolsEnabled =
    process.env["GOOGLE_HEALTH_ENABLE_PROJECT_ADMIN"] === "true";
  serveStdio(
    () =>
      createHealthMcpServer(
        { tokenProvider },
        {
          projectAdminToolsEnabled,
          ...(projectNumber ? { googleCloudProjectNumber: projectNumber } : {}),
        },
      ),
    {
      onerror: (error) =>
        process.stderr.write(`Google Health MCP: ${error.message}\n`),
    },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  serveLocalStdio();
}
