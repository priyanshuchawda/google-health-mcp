const MCP_READ = "mcp:read";
const MCP_WRITE = "mcp:write";

function allowedScopes(value: readonly string[]): string[] {
  return [
    ...new Set(
      value.filter((scope) => scope === MCP_READ || scope === MCP_WRITE),
    ),
  ];
}

async function consentKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`google-health-mcp-consent-v1\n${secret}`),
  );
  return crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signScopes(
  secret: string,
  handle: string,
  scopes: readonly string[],
): Promise<string> {
  const payload = `${handle}\n${allowedScopes(scopes).join(" ")}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await consentKey(secret),
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Render the complete, self-posting OAuth consent form. */
export function renderConsentMarkup(
  name: string,
  redirectHost: string,
  requested: readonly string[],
  handle: string,
  signature: string,
): string {
  const permitted = allowedScopes(requested);
  const scopeItems = permitted
    .map(
      (scope) =>
        `<li><label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${scope === MCP_READ ? " checked" : ""}> ${escapeHtml(scope === MCP_READ ? "Allow reading health data" : "Allow creating, updating, and deleting supported health records (optional)")}</label></li>`,
    )
    .join("");
  return `<p><strong>${escapeHtml(name)}</strong> is requesting access. Its OAuth redirect returns to <code>${escapeHtml(redirectHost)}</code>.</p><section aria-label="Google Health data disclosure"><h2>How Google Health data will be used</h2><p>This personal server requests access to the Google Health data categories listed on Google's next consent screen so it can answer your health and fitness requests. When you invoke a tool, the server sends only that request's result to this MCP client for your requested analysis. The server does not keep a copy of health records. If this client is ChatGPT or another AI service, its service receives the returned health data under its own terms. Data is not used for advertising, sold, or used to train a general-purpose AI model.</p><p>Read the <a href="https://developers.google.com/health/policies/health-api-developer-user-data-policy" rel="noreferrer">Google Health data policy</a> and this deployment's privacy information before continuing. You can deny access here or revoke Google and MCP authorization later.</p></section><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><input type="hidden" name="allowedScopes" value="${escapeHtml(permitted.join(" "))}"><input type="hidden" name="scopeSignature" value="${escapeHtml(signature)}"><ul>${scopeItems}</ul><button name="decision" value="approve">Continue to Google sign-in</button> <button name="decision" value="deny">Deny</button></form>`;
}

/** Read supported scope choices from the submitted consent form. */
export async function selectedConsentScopes(
  form: FormData,
  secret: string,
  handle: string,
): Promise<string[]> {
  const permitted = String(form.get("allowedScopes") ?? "")
    .split(" ")
    .filter(Boolean);
  const signature = String(form.get("scopeSignature") ?? "");
  if (
    !permitted.length ||
    permitted.some((scope) => scope !== MCP_READ && scope !== MCP_WRITE) ||
    signature.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    throw new TypeError("Consent scope envelope is invalid.");
  const payload = `${handle}\n${allowedScopes(permitted).join(" ")}`;
  const signatureBytes = new Uint8Array(
    signature.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)),
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    await consentKey(secret),
    signatureBytes,
    new TextEncoder().encode(payload),
  );
  if (!valid) throw new TypeError("Consent scope envelope is invalid.");
  const selected = form
    .getAll("scope")
    .map(String)
    .filter((scope) => scope === MCP_READ || scope === MCP_WRITE);
  if (!selected.includes(MCP_READ))
    throw new TypeError("Read access is required to continue.");
  if (selected.some((scope) => !permitted.includes(scope)))
    throw new TypeError(
      "Consent cannot grant scopes the client did not request.",
    );
  return [...new Set(selected)];
}

export { signScopes };
