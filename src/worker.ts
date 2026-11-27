import {
  AuthorizationError,
  OAuthProvider,
  authorizationErrorRedirect,
  type OAuthHelpers,
  type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { allHealthScopes } from "./auth/scopes.js";
import { createHealthMcpServer } from "./server.js";

const MCP_READ = "mcp:read";
const MCP_WRITE = "mcp:write";
const OIDC_SCOPES = ["openid", "email"];

interface Env {
  OAUTH_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  HEALTH_ALLOWED_EMAIL: string;
  MCP_RESOURCE: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface GoogleGrant {
  subject: string;
  email: string;
  refreshToken: string;
  googleScopes: string[];
}

interface UpstreamState {
  verifier: string;
  nonce: string;
  googleScopes: string[];
}

// Keep the shared server/tool layer independent of transport and OAuth. Google
// credentials are placed in the OAuth provider's encrypted grant properties;
// MCP access tokens never become Google bearer tokens.

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function googleClient(env: Env, callback: string): OAuth2Client {
  return new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    callback,
  );
}

function workerBaseUrl(request: Request): string {
  return new URL(request.url).origin;
}

function consentMarkup(
  name: string,
  redirectHost: string,
  requested: readonly string[],
  handle: string,
): string {
  const scopeItems = requested
    .map(
      (scope) =>
        `<li><label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope === MCP_READ ? "Read health data" : "Write supported health records")}</label></li>`,
    )
    .join("");
  return `<p><strong>${escapeHtml(name)}</strong> is requesting access. Its OAuth redirect returns to <code>${escapeHtml(redirectHost)}</code>.</p><section aria-label="Google Health data disclosure"><h2>How Google Health data will be used</h2><p>This personal server requests access to the Google Health data categories listed on Google's next consent screen so it can answer your health and fitness requests. When you invoke a tool, the server sends only that request's result to this MCP client for your requested analysis. The server does not keep a copy of health records. If this client is ChatGPT or another AI service, its service receives the returned health data under its own terms. Data is not used for advertising, sold, or used to train a general-purpose AI model.</p><p>Read the <a href="https://developers.google.com/health/policies/health-api-developer-user-data-policy" rel="noreferrer">Google Health data policy</a> and this deployment's privacy information before continuing. You can deny access here or revoke Google and MCP authorization later.</p></section><ul>${scopeItems}</ul><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><button name="decision" value="approve">Continue to Google sign-in</button> <button name="decision" value="deny">Deny</button></form>`;
}

async function startGoogleAuthorization(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
  authRequest: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>,
  headers = new Headers(),
): Promise<Response> {
  const includeWrites = authRequest.scope.includes(MCP_WRITE);
  const googleScopes = allHealthScopes(includeWrites);
  const callback = `${workerBaseUrl(request)}/google/callback`;
  const client = googleClient(env, callback);
  const { codeVerifier, codeChallenge } =
    await client.generateCodeVerifierAsync();
  if (!codeChallenge)
    throw new Error("Google OAuth did not create a PKCE challenge.");
  const nonce = randomToken();
  const upstream = await oauth.beginUpstream(authRequest, {
    data: {
      verifier: codeVerifier,
      nonce,
      googleScopes,
    } satisfies UpstreamState,
    headers,
  });
  const location = client.generateAuthUrl({
    access_type: "offline",
    include_granted_scopes: true,
    prompt: "consent",
    scope: [...OIDC_SCOPES, ...googleScopes],
    state: upstream.state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
  upstream.headers.set("location", location);
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (request.method === "GET") {
    try {
      const parsed = await oauth.parseAuthRequest(request);
      const requested = parsed.scope.filter((scope) =>
        [MCP_READ, MCP_WRITE].includes(scope),
      );
      if (!requested.includes(MCP_READ))
        return htmlPage(
          "Health MCP authorization",
          "<p>The read scope is required.</p>",
          400,
        );
      const details = await oauth.describeConsent(parsed);
      const consent = await oauth.beginConsent(parsed);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      consent.headers.set("cache-control", "no-store");
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Health MCP authorization</title><h1>Health MCP authorization</h1>${consentMarkup(details.clientName, details.redirectHost, requested, consent.handle)}`,
        { headers: consent.headers },
      );
    } catch (error) {
      if (error instanceof AuthorizationError) {
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return htmlPage(
          "Authorization request rejected",
          escapeHtml(error.description),
          400,
        );
      }
      throw error;
    }
  }

  if (request.method === "POST") {
    try {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const requestedScopes = form.getAll("scope").map(String);
      if (!requestedScopes.includes(MCP_READ))
        return htmlPage(
          "Read access is required",
          "<p>Allow read access to continue.</p>",
          400,
        );
      const approved = await oauth.approveConsent(request, handle, {
        scope: requestedScopes.filter((scope) =>
          [MCP_READ, MCP_WRITE].includes(scope),
        ),
      });
      return startGoogleAuthorization(
        request,
        env,
        oauth,
        approved.request,
        approved.headers,
      );
    } catch (error) {
      if (error instanceof AuthorizationError) {
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return htmlPage(
          "Authorization request expired",
          escapeHtml(error.description),
          400,
        );
      }
      throw error;
    }
  }
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "GET, POST" },
  });
}

async function handleGoogleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const resumed = await oauth.finishUpstream<UpstreamState>(request);
  const query = new URL(request.url).searchParams;
  const upstreamError = query.get("error");
  if (upstreamError) {
    const redirect = authorizationErrorRedirect(
      resumed.request,
      "access_denied",
    );
    resumed.headers.set("location", redirect);
    return new Response(null, { status: 302, headers: resumed.headers });
  }

  const code = query.get("code");
  if (!code)
    return htmlPage(
      "Google sign-in failed",
      "<p>The authorization code was missing.</p>",
      400,
    );
  const callback = `${workerBaseUrl(request)}/google/callback`;
  const client = googleClient(env, callback);
  const { tokens } = await client.getToken({
    code,
    codeVerifier: resumed.data.verifier,
  });
  if (!tokens.id_token || !tokens.refresh_token)
    return htmlPage(
      "Google access incomplete",
      "<p>Google did not return the required identity and offline-access credentials. Revoke access and authorize again.</p>",
      400,
    );

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const identity = ticket.getPayload();
  if (
    !identity?.sub ||
    identity.nonce !== resumed.data.nonce ||
    identity.email_verified !== true ||
    identity.email?.toLowerCase() !== env.HEALTH_ALLOWED_EMAIL.toLowerCase()
  )
    return htmlPage(
      "Google account not allowed",
      "<p>This personal MCP deployment is restricted to its configured Google account.</p>",
      403,
    );

  const actualScopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  const missing = resumed.data.googleScopes.filter(
    (scope) => !actualScopes.includes(scope),
  );
  if (missing.length)
    return htmlPage(
      "Google Health permissions incomplete",
      `<p>Google did not grant all requested permissions. Missing scope count: ${missing.length}.</p>`,
      403,
    );

  const redirect = await oauth.completeAuthorization({
    request: resumed.request,
    userId: `google-${identity.sub}`,
    metadata: { provider: "google" },
    scope: resumed.request.scope,
    props: {
      subject: identity.sub,
      email: identity.email,
      refreshToken: tokens.refresh_token,
      googleScopes: actualScopes,
    } satisfies GoogleGrant,
  });
  resumed.headers.set("location", redirect.redirectTo);
  return new Response(null, { status: 302, headers: resumed.headers });
}

class GoogleHealthTokenProvider {
  private readonly google: OAuth2Client;

  constructor(
    env: Env,
    private readonly grant: GoogleGrant,
    private readonly mcpScopes: readonly string[],
  ) {
    this.google = googleClient(env, "");
    this.google.setCredentials({ refresh_token: grant.refreshToken });
  }

  async getAccessToken(scopes: readonly string[]): Promise<string> {
    if (scopes.some((scope) => !this.grant.googleScopes.includes(scope)))
      throw new Error(
        "The Google account has not granted a required Health API permission.",
      );
    if (
      scopes.some((scope) => scope.endsWith(".writeonly")) &&
      !this.mcpScopes.includes(MCP_WRITE)
    )
      throw new Error(
        "This MCP client has read-only authorization; request write access first.",
      );
    const token = await this.google.getAccessToken();
    if (!token.token)
      throw new Error("Google did not return a Health API access token.");
    return token.token;
  }
}

function workerMcpHandler(
  request: Request,
  env: Env,
  props: GoogleGrant,
  auth: OAuthResourceAuth,
) {
  const mcpScopes = auth.scope;
  if (!mcpScopes.includes(MCP_READ))
    return new Response("Insufficient MCP scope", { status: 403 });
  if (
    !props.email ||
    props.email.toLowerCase() !== env.HEALTH_ALLOWED_EMAIL.toLowerCase()
  )
    return new Response(
      "This deployment is no longer authorized for the configured Google account.",
      { status: 403 },
    );
  const tokenProvider = new GoogleHealthTokenProvider(env, props, mcpScopes);
  const handler = createMcpHandler(() =>
    createHealthMcpServer({ tokenProvider }),
  );
  return handler.fetch(request);
}

// Reuse the provider inside a Worker isolate; it is configuration-only and
// receives the current environment on every fetch, so no user's data is cached.
let providerCache:
  { resourceUrl: string; instance: OAuthProvider<Env> } | undefined;

function createProvider(env: Env): OAuthProvider<Env> {
  const resourceUrl = env.MCP_RESOURCE;
  if (!resourceUrl)
    throw new Error(
      "MCP_RESOURCE must identify this deployment's /mcp endpoint.",
    );
  if (providerCache?.resourceUrl === resourceUrl) return providerCache.instance;
  const parsedResource = new URL(resourceUrl);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const isLocalHttp =
    parsedResource.protocol === "http:" &&
    loopbackHosts.has(parsedResource.hostname);
  if (parsedResource.protocol !== "https:" && !isLocalHttp)
    throw new Error(
      "MCP_RESOURCE must use HTTPS, except for loopback local development.",
    );
  const resourceOrigin = parsedResource.origin;
  if (parsedResource.pathname !== "/mcp")
    throw new Error("MCP_RESOURCE must end with the /mcp path.");
  const instance = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch(request, env, ctx) {
        const authContext = ctx as typeof ctx & { auth: OAuthResourceAuth };
        return workerMcpHandler(
          request,
          env,
          authContext.props as GoogleGrant,
          authContext.auth,
        );
      },
    },
    defaultHandler: {
      fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path === "/authorize") return handleAuthorize(request, env);
        if (path === "/google/callback" && request.method === "GET")
          return handleGoogleCallback(request, env);
        return new Response("Not found", { status: 404 });
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    scopesSupported: [MCP_READ, MCP_WRITE, "offline_access"],
    requiredScopes: [MCP_READ],
    resourceMetadata: {
      resource: resourceUrl,
      authorization_servers: [resourceOrigin],
      bearer_methods_supported: ["header"],
    },
    clientIdMetadataDocumentEnabled: true,
  });
  providerCache = { resourceUrl, instance };
  return instance;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createProvider(env).fetch(request, env, ctx);
  },
};
