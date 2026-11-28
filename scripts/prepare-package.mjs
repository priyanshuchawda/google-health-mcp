import { chmod } from "node:fs/promises";
import process from "node:process";

// npm links the CLI executable from this file on Unix-like systems.
if (process.platform !== "win32") {
  await chmod("dist/src/cli.js", 0o755);
}
