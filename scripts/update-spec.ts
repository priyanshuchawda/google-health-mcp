import { writeFile } from "node:fs/promises";

const versions = ["v4", "v4beta"] as const;
const source = "https://developers.google.com/health/reference/rest";

type DiscoveryMethod = {
  id: string;
  httpMethod: string;
  path: string;
  description?: string;
  parameters?: Record<string, Record<string, unknown>>;
  request?: { $ref?: string };
  response?: { $ref?: string };
};

function collectMethods(resources: Record<string, unknown>): DiscoveryMethod[] {
  const found: DiscoveryMethod[] = [];
  for (const value of Object.values(resources)) {
    if (!value || typeof value !== "object") continue;
    const resource = value as {
      methods?: Record<string, DiscoveryMethod>;
      resources?: Record<string, unknown>;
    };
    if (resource.methods) found.push(...Object.values(resource.methods));
    if (resource.resources) found.push(...collectMethods(resource.resources));
  }
  return found;
}

async function readDiscovery(version: (typeof versions)[number]) {
  const url = `https://health.googleapis.com/$discovery/rest?version=${version}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(
      `Google discovery fetch failed for ${version}: HTTP ${response.status}`,
    );

  const document = (await response.json()) as {
    resources?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
  if (!document.resources)
    throw new Error(
      `Google discovery document for ${version} has no resources.`,
    );

  const methods = collectMethods(document.resources)
    .map((method) => ({
      id: method.id,
      httpMethod: method.httpMethod,
      path: method.path,
      description: method.description ?? "",
      parameters: Object.entries(method.parameters ?? {}).map(
        ([name, parameter]) => ({
          name,
          location: parameter.location,
          type: parameter.type,
          ...(parameter.required === undefined
            ? {}
            : { required: parameter.required }),
          ...(parameter.format === undefined
            ? {}
            : { format: parameter.format }),
          ...(parameter.enum === undefined ? {} : { enum: parameter.enum }),
          ...(parameter.description === undefined
            ? {}
            : { description: parameter.description }),
        }),
      ),
      ...(method.request?.$ref ? { requestSchema: method.request.$ref } : {}),
      ...(method.response?.$ref
        ? { responseSchema: method.response.$ref }
        : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (
    methods.length === 0 ||
    methods.some((method) => !method.id || !method.path || !method.httpMethod)
  ) {
    throw new Error(
      `Google discovery document for ${version} returned no complete methods.`,
    );
  }
  return { methods, schemas: document.schemas ?? {} };
}

const discovered = Object.fromEntries(
  await Promise.all(
    versions.map(async (version) => [version, await readDiscovery(version)]),
  ),
);
const result = {
  source,
  discoveryDocuments: Object.fromEntries(
    versions.map((version) => [
      version,
      `https://health.googleapis.com/$discovery/rest?version=${version}`,
    ]),
  ),
  verifiedOn: new Date().toISOString().slice(0, 10),
  versions: Object.fromEntries(
    versions.map((version) => [version, discovered[version].methods]),
  ),
  schemas: Object.fromEntries(
    versions.map((version) => [version, discovered[version].schemas]),
  ),
};

await writeFile(
  new URL("../spec/api-methods.json", import.meta.url),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  `Updated official Google Health discovery metadata: ${versions.map((version) => `${version}=${result.versions[version].length} methods, ${Object.keys(result.schemas[version]).length} schemas`).join(", ")}`,
);
