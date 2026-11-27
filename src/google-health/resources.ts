import type { HealthApi } from "./client.js";

const USER_ID = "[A-Za-z0-9-]{1,63}";
const RECORD_ID = "[A-Za-z0-9-]{1,63}";
const healthUserIdCache = new WeakMap<HealthApi, Promise<string>>();

function getHealthUserId(api: HealthApi): Promise<string> {
  const cached = healthUserIdCache.get(api);
  if (cached) return cached;
  const request = api
    .request<unknown>({
      methodId: "health.users.getIdentity",
      pathParams: { name: "users/me/identity" },
    })
    .then((identity) => {
      if (
        typeof identity !== "object" ||
        identity === null ||
        Array.isArray(identity) ||
        !("healthUserId" in identity) ||
        typeof identity.healthUserId !== "string" ||
        !new RegExp(`^${USER_ID}$`).test(identity.healthUserId)
      )
        throw new TypeError(
          "Google Health did not return a valid authenticated user identifier.",
        );
      return identity.healthUserId;
    })
    .catch((error: unknown) => {
      healthUserIdCache.delete(api);
      throw error;
    });
  healthUserIdCache.set(api, request);
  return request;
}

async function requireOwnedUser(
  api: HealthApi,
  userSegment: string,
): Promise<void> {
  if (userSegment === "me") return;
  if ((await getHealthUserId(api)) !== userSegment)
    throw new TypeError(
      "Resource name does not belong to the authenticated Google Health account.",
    );
}

/** Verify an API-returned data point name and normalize its account alias. */
export async function normalizeOwnedDataPointName(
  api: HealthApi,
  name: string,
  expectedType: string,
): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expectedType))
    throw new TypeError("Data type must be a valid Google Health slug.");
  const match = name.match(
    new RegExp(
      `^users/(${USER_ID}|me)/dataTypes/([a-z0-9]+(?:-[a-z0-9]+)*)/dataPoints/(${RECORD_ID})$`,
    ),
  );
  if (!match || match[2] !== expectedType)
    throw new TypeError(
      `Record name must identify one ${expectedType} data point in this Google Health account.`,
    );
  await requireOwnedUser(api, match[1]!);
  return `users/me/dataTypes/${expectedType}/dataPoints/${match[3]}`;
}

/** Verify a paired-device resource name and normalize its account alias. */
export async function normalizeOwnedDeviceName(
  api: HealthApi,
  name: string,
): Promise<string> {
  const match = name.match(
    new RegExp(`^users/(${USER_ID}|me)/pairedDevices/(${RECORD_ID})$`),
  );
  if (!match)
    throw new TypeError(
      "Device name must identify one paired device in this Google Health account.",
    );
  await requireOwnedUser(api, match[1]!);
  return `users/me/pairedDevices/${match[2]}`;
}
