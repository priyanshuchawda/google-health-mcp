import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CodeChallengeMethod,
  OAuth2Client,
  type Credentials,
} from "google-auth-library";
import type { HealthTokenProvider } from "../google-health/client.js";
import { allHealthScopes } from "./scopes.js";
export { allHealthScopes } from "./scopes.js";

const clientSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  }),
});

const credentialsSchema = z.object({
  type: z.literal("authorized_user"),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
  scopes: z.array(z.string().url()).min(1),
});

export type LocalCredentials = z.infer<typeof credentialsSchema>;

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["GOOGLE_HEALTH_CREDENTIALS"] ??
    join(homedir(), ".config", "google-health-mcp", "credentials.json")
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GoogleOAuthClient {
  generateCodeVerifierAsync(): Promise<{
    codeVerifier: string;
    codeChallenge?: string;
  }>;
  generateAuthUrl(
    options: NonNullable<Parameters<OAuth2Client["generateAuthUrl"]>[0]>,
  ): string;
  getToken(options: {
    code: string;
    codeVerifier: string;
  }): Promise<{ tokens: Credentials }>;
  setCredentials(credentials: Credentials): void;
  getAccessToken(): Promise<{ token?: string | null }>;
}

export type OAuthClientFactory = (options: {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}) => GoogleOAuthClient;
const googleOAuthClient: OAuthClientFactory = (options) =>
  new OAuth2Client(options);

export async function saveLocalCredentials(
  path: string,
  credentials: LocalCredentials,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function loadLocalCredentials(
  path = credentialsPath(),
): Promise<LocalCredentials> {
  try {
    return credentialsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new Error(
      `No valid Google Health authorization at ${path}. Run "npm run auth -- --client-secrets <file>" first.`,
    );
  }
}

export interface LocalAuthOptions {
  clientSecretsPath: string;
  credentialsOutputPath?: string;
  includeWrites?: boolean;
  includeProjectAdmin?: boolean;
  port?: number;
  timeoutMs?: number;
  oauthClientFactory?: OAuthClientFactory;
  openBrowser?: (url: string) => void;
}

/** Runs Google authorization on a loopback-only callback with PKCE and state validation. */
export async function runLocalAuthorization(
  options: LocalAuthOptions,
): Promise<string> {
  const parsedClient = clientSchema.parse(
    JSON.parse(await readFile(options.clientSecretsPath, "utf8")),
  );
  const client = parsedClient.installed;
  const scopes = allHealthScopes(
    options.includeWrites ?? false,
    options.includeProjectAdmin ?? false,
  );
  const state = randomBytes(32).toString("base64url");
  let acceptCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    acceptCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? "/", "http://127.0.0.1");
    if (callback.pathname !== "/oauth2callback") {
      response.writeHead(404).end();
      return;
    }
    if (callback.searchParams.get("error")) {
      response
        .writeHead(400)
        .end("Google authorization was not completed. Return to the terminal.");
      rejectCode(new Error("Google authorization was denied or cancelled."));
      return;
    }
    const returnedState = callback.searchParams.get("state") ?? "";
    const authCode = callback.searchParams.get("code");
    if (!safeEqual(returnedState, state) || !authCode) {
      response
        .writeHead(400)
        .end("Authorization response did not match this sign-in request.");
      rejectCode(
        new Error("Google authorization callback failed state validation."),
      );
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Google Health connected. You may close this tab.");
    acceptCode(authCode);
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Could not start the local OAuth callback.");
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    const oauth = (options.oauthClientFactory ?? googleOAuthClient)({
      clientId: client.client_id,
      clientSecret: client.client_secret,
      redirectUri,
    });
    const { codeVerifier, codeChallenge } =
      await oauth.generateCodeVerifierAsync();
    if (!codeChallenge)
      throw new Error(
        "Google OAuth library did not generate a PKCE challenge.",
      );
    const authorizationUrl = oauth.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent",
      include_granted_scopes: true,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    console.log(
      `Open this URL to authorize Google Health: ${authorizationUrl}`,
    );
    options.openBrowser?.(authorizationUrl);
    timer = setTimeout(
      () => rejectCode(new Error("Google authorization timed out.")),
      options.timeoutMs ?? 600_000,
    );
    const token = await oauth.getToken({ code: await code, codeVerifier });
    const refreshToken = token.tokens.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken)
      throw new Error(
        "Google did not return a refresh token; revoke access and authorize again.",
      );
    const credentials = credentialsSchema.parse({
      type: "authorized_user",
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refreshToken,
      scopes: token.tokens.scope
        ? scopes.filter((scope) =>
            token.tokens.scope!.split(" ").includes(scope),
          )
        : scopes,
    });
    const outputPath = options.credentialsOutputPath ?? credentialsPath();
    await saveLocalCredentials(outputPath, credentials);
    return outputPath;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

export function createLocalTokenProvider(
  options: {
    path?: string;
    oauthClientFactory?: OAuthClientFactory;
  } = {},
): HealthTokenProvider {
  let credentialsPromise: Promise<LocalCredentials> | undefined;
  let oauthPromise: Promise<GoogleOAuthClient> | undefined;
  const getCredentials = () => {
    credentialsPromise ??= loadLocalCredentials(options.path).catch(
      (error: unknown) => {
        credentialsPromise = undefined;
        throw error;
      },
    );
    return credentialsPromise;
  };
  const getOAuth = (credentials: LocalCredentials) => {
    oauthPromise ??= Promise.resolve()
      .then(() => {
        const oauth = (options.oauthClientFactory ?? googleOAuthClient)({
          clientId: credentials.client_id,
          clientSecret: credentials.client_secret,
        });
        oauth.setCredentials({ refresh_token: credentials.refresh_token });
        return oauth;
      })
      .catch((error: unknown) => {
        oauthPromise = undefined;
        throw error;
      });
    return oauthPromise;
  };
  return {
    async getAccessToken(requestedScopes) {
      const credentials = await getCredentials();
      const granted = new Set(credentials.scopes);
      if (requestedScopes.some((scope) => !granted.has(scope))) {
        throw new Error(
          "Google Health authorization lacks required permissions. Re-run the auth command with --write if a write tool needs access.",
        );
      }
      const oauth = await getOAuth(credentials);
      const token = await oauth.getAccessToken();
      if (!token.token)
        throw new Error(
          "Google token refresh failed. Re-run local authorization.",
        );
      return token.token;
    },
  };
}
