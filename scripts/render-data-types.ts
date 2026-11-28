import { readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";

interface DataTypeEntry {
  slug: string;
  kind: string;
  scopes: string[];
  operations: string[];
  beta?: boolean;
}

const snapshot = JSON.parse(
  await readFile(new URL("../spec/data-types.json", import.meta.url), "utf8"),
) as { source: string; verifiedOn: string; dataTypes: DataTypeEntry[] };

const rows = snapshot.dataTypes
  .map((entry) => {
    const categories = [
      ...new Set(
        entry.scopes.map(
          (scope) =>
            scope
              .split("googlehealth.")[1]
              ?.replace(/\.(?:readonly|writeonly)$/, "") ?? "unknown",
        ),
      ),
    ].join(", ");
    return `| \`${entry.slug}\` | ${entry.beta ? "v4beta" : "v4"} | ${entry.kind} | ${entry.operations.map((operation) => `\`${operation}\``).join(", ")} | ${categories} |`;
  })
  .join("\n");

const markdown = `# Google Health data types\n\nThis table is the checked-in capability snapshot used by the generic MCP data tools. It was reviewed against [Google's data type catalog](${snapshot.source}) on ${snapshot.verifiedOn}. The exact API methods and request/response schemas come from the official discovery documents tracked in [api-methods.json](../spec/api-methods.json).\n\nThe API version column marks beta-only data types; the generic read tool selects v4beta automatically for those entries. The operation list is authoritative for tool validation: reads and writes are checked per data type before a request is sent. Scope categories are shown for orientation; see Google's current documentation for their exact semantics. The food resource is a reference collection, not a personal meal log. This server does not infer native goals from this catalog. Google's calories guide and migration material describe basal metabolic/basal energy values differently, but this 44-entry catalog does not list a standalone \`basal-energy-burned\` record type. Google's [Health CLI](https://github.com/Google-Health-API/google-health-cli) lists basal energy as list/reconcile, which conflicts with the catalog and calories guide's statement that the API does not provide it as an independent data type. We keep it out of the supported registry pending authenticated live API verification. Basal energy and HRV/resting-heart-rate personal ranges appear in schema/rollup fields, not as standalone record types here.\n\n| Slug | API version | Kind | Supported operations | OAuth scope categories |\n| --- | --- | --- | --- | --- |\n${rows}\n`;

const formatted = await prettier.format(markdown, { parser: "markdown" });
await writeFile(new URL("../docs/data-types.md", import.meta.url), formatted);
console.log(`Rendered ${snapshot.dataTypes.length} Google Health data types.`);
