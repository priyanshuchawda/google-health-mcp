import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allHealthScopes,
  createLocalTokenProvider,
  loadLocalCredentials,
  runLocalAuthorization,
  type GoogleOAuthClient,
} from "../../src/auth/local.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(scopes: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ghmcp-auth-"));
  directories.push(dir);
  const path = join(dir, "credentials.json");
  await writeFile(
    path,
    JSON.stringify({
      type: "authorized_user",
      client_id: "synthetic-client-id",
      client_secret: "synthetic-client-secret",
      refresh_token: "synthetic-refresh-token",
      scopes,
    }),
  );
  return path;
}

describe("local Google OAuth credentials", () => {
  it("requires explicit data-sharing consent before opening Google's OAuth page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghmcp-auth-consent-"));
    directories.push(dir);
    const clientSecretsPath = join(dir, "client_secret.json");
    await writeFile(
      clientSecretsPath,
      JSON.stringify({
        installed: {
          client_id: "synthetic-client-id",
          client_secret: "synthetic-client-secret",
        },
      }),
    );
    const oauth = {
      generateCodeVerifierAsync: vi.fn(async () => ({
        codeVerifier: "synthetic-verifier",
        codeChallenge: "synthetic-challenge",
      })),
      generateAuthUrl: vi.fn(() => "https://accounts.google.com/synthetic"),
      getToken: vi.fn(),
      setCredentials: vi.fn(),
      getAccessToken: vi.fn(),
    } as unknown as GoogleOAuthClient;
    const openBrowser = vi.fn();
    const confirmAccess = vi.fn(async () => false);

    await expect(
      runLocalAuthorization({
        clientSecretsPath,
        oauthClientFactory: () => oauth,
        openBrowser,
        confirmAccess,
      }),
    ).rejects.toThrow(/cancelled before browser sign-in/i);
    expect(confirmAccess).toHaveBeenCalledOnce();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(oauth.getToken).not.toHaveBeenCalled();
  });

  it("requests read scopes by default and adds only documented writable scopes on request", () => {
    const read = allHealthScopes();
    const readWrite = allHealthScopes(true);
    expect(read.length).toBeGreaterThan(1);
    expect(read.every((scope) => scope.endsWith(".readonly"))).toBe(true);
    expect(readWrite).toEqual(expect.arrayContaining(read));
    expect(readWrite.some((scope) => scope.endsWith(".writeonly"))).toBe(true);
    expect(readWrite).not.toContain(
      "https://www.googleapis.com/auth/cloud-platform",
    );
  });

  it("fails closed when the stored authorization lacks a requested scope", async () => {
    const readonlyScope =
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly";
    const path = await fixture([readonlyScope]);
    const oauthClientFactory = vi.fn(
      () =>
        ({
          generateCodeVerifierAsync: vi.fn(),
          generateAuthUrl: vi.fn(),
          getToken: vi.fn(),
          setCredentials: vi.fn(),
          getAccessToken: vi.fn(),
        }) as unknown as GoogleOAuthClient,
    );
    const provider = createLocalTokenProvider({ path, oauthClientFactory });
    await expect(
      provider.getAccessToken([
        `${readonlyScope.slice(0, -"readonly".length)}writeonly`,
      ]),
    ).rejects.toThrow(/lacks required permissions/i);
    expect(oauthClientFactory).not.toHaveBeenCalled();
  });

  it("refreshes once and reuses an unexpired access token", async () => {
    const scope =
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly";
    const path = await fixture([scope]);
    const oauth = {
      generateCodeVerifierAsync: vi.fn(),
      generateAuthUrl: vi.fn(),
      getToken: vi.fn(),
      setCredentials: vi.fn(),
      getAccessToken: vi
        .fn()
        .mockResolvedValue({ token: "synthetic-access-token" }),
    } as unknown as GoogleOAuthClient;
    const oauthClientFactory = vi.fn(() => oauth);
    const provider = createLocalTokenProvider({ path, oauthClientFactory });
    await expect(provider.getAccessToken([scope])).resolves.toBe(
      "synthetic-access-token",
    );
    await expect(provider.getAccessToken([scope])).resolves.toBe(
      "synthetic-access-token",
    );
    expect(oauthClientFactory).toHaveBeenCalledTimes(1);
    expect(oauth.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("does not reveal malformed credential file contents in errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghmcp-auth-invalid-"));
    directories.push(dir);
    const path = join(dir, "credentials.json");
    await writeFile(path, "synthetic-secret-that-must-not-leak");
    await expect(loadLocalCredentials(path)).rejects.not.toThrow(
      "synthetic-secret-that-must-not-leak",
    );
  });
});
