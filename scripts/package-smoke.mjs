import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "ghealth-mcp-package-"));
const npmCli = process.env["npm_execpath"];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runNpm(args, options = {}) {
  if (process.platform === "win32") {
    if (!npmCli)
      throw new Error("npm_execpath is missing from the environment.");
    return run(process.execPath, [npmCli, ...args], options);
  }
  return run("npm", args, options);
}

try {
  run(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.build.json",
  ]);
  await import("./prepare-package.mjs");

  const packOutput = runNpm([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temp,
  ]);
  const packData = JSON.parse(packOutput);
  const pack = Array.isArray(packData)
    ? packData[0]
    : (packData["ghealth-mcp"] ?? Object.values(packData)[0]);
  if (!pack?.filename) throw new Error("npm pack did not return an artifact.");

  const included = new Set(pack.files.map((file) => file.path));
  for (const expected of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/src/cli.js",
    "dist/src/index.js",
    "dist/spec/data-types.json",
    "dist/spec/api-methods.json",
  ]) {
    if (!included.has(expected))
      throw new Error(`Packed npm artifact is missing ${expected}.`);
  }
  const cliFile = pack.files.find((file) => file.path === "dist/src/cli.js");
  if (
    !cliFile ||
    (process.platform !== "win32" && (cliFile.mode & 0o111) === 0)
  ) {
    throw new Error("The packaged ghealth-mcp CLI is not executable.");
  }
  const forbidden = [...included].filter(
    (file) =>
      /(^|\/)(tests?|\.dev\.vars|\.env|client_secret[^/]*\.json)(\/|$)/i.test(
        file,
      ) || file.endsWith(".map"),
  );
  if (forbidden.length)
    throw new Error(
      `Private or development files were packed: ${forbidden.join(", ")}`,
    );

  const installDir = join(temp, "install");
  const archive = join(temp, pack.filename);
  runNpm([
    "install",
    "--prefix",
    installDir,
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    archive,
  ]);
  const installedRoot = join(installDir, "node_modules", "ghealth-mcp");
  const installedManifest = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  if (installedManifest.bin?.["ghealth-mcp"] !== "./dist/src/cli.js")
    throw new Error(
      "The installed package does not expose the ghealth-mcp bin.",
    );
  const help = run(
    process.execPath,
    [join(installedRoot, "dist", "src", "cli.js"), "--help"],
    { cwd: installDir },
  );
  if (!help.includes("Google Health MCP local commands:"))
    throw new Error("The installed ghealth-mcp command did not start.");

  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { createHealthMcpServer, dataTypes } from 'ghealth-mcp'; if (typeof createHealthMcpServer !== 'function' || dataTypes.length < 40) process.exit(1)",
    ],
    { cwd: installDir },
  );
  process.stdout.write(
    `npm package smoke test passed (${included.size} files; CLI and exports loaded).\n`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
