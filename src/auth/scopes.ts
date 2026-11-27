import { dataTypes } from "../google-health/capabilities.js";

/** Returns the scopes this build can use; write/admin scopes stay opt-in. */
export function allHealthScopes(
  includeWrites = false,
  includeProjectAdmin = false,
): string[] {
  const scopes = new Set(
    dataTypes.flatMap((type) =>
      type.scopes.filter((scope) => scope.endsWith(".readonly")),
    ),
  );
  scopes.add("https://www.googleapis.com/auth/googlehealth.profile.readonly");
  // These account endpoints are not represented by a data-type catalog row.
  scopes.add("https://www.googleapis.com/auth/googlehealth.irn.readonly");
  scopes.add("https://www.googleapis.com/auth/googlehealth.settings.readonly");
  // TCX exports require activity plus location read permissions.
  scopes.add("https://www.googleapis.com/auth/googlehealth.location.readonly");
  if (includeWrites) {
    for (const type of dataTypes) {
      if (
        type.operations.some((operation) =>
          ["create", "patch", "batchDelete"].includes(operation),
        )
      ) {
        for (const scope of type.scopes.filter((item) =>
          item.endsWith(".writeonly"),
        ))
          scopes.add(scope);
      }
    }
    scopes.add(
      "https://www.googleapis.com/auth/googlehealth.profile.writeonly",
    );
    scopes.add(
      "https://www.googleapis.com/auth/googlehealth.settings.writeonly",
    );
  }
  if (includeProjectAdmin)
    scopes.add("https://www.googleapis.com/auth/cloud-platform");
  return [...scopes].sort();
}
