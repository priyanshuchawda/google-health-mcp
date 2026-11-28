import { describe, expect, it } from "vitest";
import {
  renderConsentMarkup,
  selectedConsentScopes,
  signScopes,
} from "../../src/auth/consent.js";

const secret = "synthetic-consent-secret";
const handle = "opaque-consent-handle";

async function consentForm(scopes: string[]): Promise<FormData> {
  const form = new FormData();
  const signature = await signScopes(secret, handle, scopes);
  form.append("allowedScopes", scopes.join(" "));
  form.append("scopeSignature", signature);
  return form;
}

describe("remote OAuth consent form", () => {
  it("places the selected read and write scopes inside the submitted form", async () => {
    const signature = await signScopes(secret, handle, [
      "mcp:read",
      "mcp:write",
    ]);
    const html = renderConsentMarkup(
      "Synthetic MCP client",
      "client.example",
      ["mcp:read", "mcp:write"],
      handle,
      signature,
    );
    const form = html.match(/<form\b[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain('name="scope" value="mcp:read" checked');
    expect(form).toContain('name="scope" value="mcp:write">');
    expect(form).toContain(
      "Allow creating, updating, and deleting supported health records (optional)",
    );
    expect(form).toContain('name="handle" value="opaque-consent-handle"');
  });

  it("processes browser-style FormData for read-only and read/write approvals", async () => {
    const readOnly = await consentForm(["mcp:read"]);
    readOnly.append("scope", "mcp:read");
    await expect(
      selectedConsentScopes(readOnly, secret, handle),
    ).resolves.toEqual(["mcp:read"]);

    const readWrite = await consentForm(["mcp:read", "mcp:write"]);
    readWrite.append("scope", "mcp:read");
    readWrite.append("scope", "mcp:write");
    await expect(
      selectedConsentScopes(readWrite, secret, handle),
    ).resolves.toEqual(["mcp:read", "mcp:write"]);
  });

  it("rejects missing read consent and discards unsupported scope values", async () => {
    const form = await consentForm(["mcp:read", "mcp:write"]);
    form.append("scope", "mcp:write");
    form.append("scope", "googlehealth.profile.readonly");
    await expect(selectedConsentScopes(form, secret, handle)).rejects.toThrow(
      /read access/i,
    );
  });

  it("does not allow a form edit to add write permission to a read-only client", async () => {
    const form = await consentForm(["mcp:read"]);
    form.append("scope", "mcp:read");
    form.append("scope", "mcp:write");
    await expect(selectedConsentScopes(form, secret, handle)).rejects.toThrow(
      /did not request/i,
    );
  });

  it("binds approved scopes to the OAuth handle and signing secret", async () => {
    const form = await consentForm(["mcp:read", "mcp:write"]);
    form.append("scope", "mcp:read");
    await expect(
      selectedConsentScopes(form, secret, "different-handle"),
    ).rejects.toThrow(/envelope/i);
    await expect(
      selectedConsentScopes(form, "different-secret", handle),
    ).rejects.toThrow(/envelope/i);
  });
});
