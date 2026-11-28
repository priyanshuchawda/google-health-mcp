import {
  AuthorizationError,
  OAuthProvider,
  authorizationErrorRedirect,
  type OAuthHelpers,
  type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { OAuth2Client } from "google-auth-library";
import { allHealthScopes } from "./auth/scopes.js";
import { acceptedHealthScopes } from "./auth/granted-scopes.js";
import { InsufficientHealthPermissionError } from "./auth/permission-errors.js";
import { advertiseSupportedMcpScopes } from "./auth/resource-metadata.js";
import { googleAuthorizationOptions } from "./auth/google-authorization.js";
import {
  renderConsentMarkup,
  selectedConsentScopes,
  signScopes,
} from "./auth/consent.js";
import { createHealthMcpServer } from "./server.js";

const MCP_READ = "mcp:read";
const MCP_WRITE = "mcp:write";

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
  requestedGoogleScopes?: string[];
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
  const location = client.generateAuthUrl(
    googleAuthorizationOptions({
      googleScopes,
      state: upstream.state,
      nonce,
      codeChallenge,
    }),
  );
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
      const signature = await signScopes(
        env.GOOGLE_CLIENT_SECRET,
        consent.handle,
        requested,
      );
      consent.headers.set("content-type", "text/html; charset=utf-8");
      consent.headers.set("cache-control", "no-store");
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Health MCP authorization</title><h1>Health MCP authorization</h1>${renderConsentMarkup(details.clientName, details.redirectHost, requested, consent.handle, signature)}`,
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
      let requestedScopes: string[];
      try {
        requestedScopes = await selectedConsentScopes(
          form,
          env.GOOGLE_CLIENT_SECRET,
          handle,
        );
      } catch {
        return htmlPage(
          "Read access is required",
          "<p>Allow read access to continue.</p>",
          400,
        );
      }
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
  if (!tokens.id_token)
    return htmlPage(
      "Google access incomplete",
      "<p>Google did not return the identity token needed to verify the authorized account. No authorization was saved. Reconnect this MCP and try again.</p>",
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

  // Google omits `scope` when the grant equals the requested set. In that
  // case, the upstream request scope list is the granted set; partial grants
  // are returned explicitly and are handled below.
  const actualScopes = (tokens.scope ?? resumed.data.googleScopes.join(" "))
    .split(/\s+/)
    .filter(Boolean);
  let grantedHealthScopes: string[];
  try {
    grantedHealthScopes = acceptedHealthScopes(
      actualScopes,
      resumed.data.googleScopes,
      ["openid", "email", "https://www.googleapis.com/auth/userinfo.email"],
    ).healthScopes;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const title = error.message.includes("at least one scope")
      ? "Google Health permission required"
      : "Unexpected Google permissions";
    return htmlPage(
      title,
      `<p>${escapeHtml(error.message)} No authorization was saved. Grant at least one Google Health category and reconnect this MCP connection.</p>`,
      403,
    );
  }
  if (!tokens.refresh_token)
    return htmlPage(
      "Google offline access incomplete",
      "<p>Google did not return the refresh token needed for background-free, on-demand API access. No authorization was saved. Reconnect this MCP and approve offline access.</p>",
      400,
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
      googleScopes: grantedHealthScopes,
      requestedGoogleScopes: resumed.data.googleScopes,
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
    const missingGoogleScopes = scopes.filter(
      (scope) => !this.grant.googleScopes.includes(scope),
    );
    if (missingGoogleScopes.length) {
      const categories = missingGoogleScopes
        .map((scope) => scope.split("googlehealth.").at(-1))
        .filter(Boolean)
        .join(", ");
      const writeNeeded = missingGoogleScopes.some((scope) =>
        scope.endsWith(".writeonly"),
      );
      throw new InsufficientHealthPermissionError(
        `Google Health permission is missing for: ${categories}. Reconnect this MCP and grant the relevant Google Health category; granular consent can be enabled per category.`,
        writeNeeded ? [MCP_READ, MCP_WRITE] : [MCP_READ],
      );
    }
    if (
      scopes.some((scope) => scope.endsWith(".writeonly")) &&
      !this.mcpScopes.includes(MCP_WRITE)
    )
      throw new InsufficientHealthPermissionError(
        "This MCP connection has read-only authorization. Reconnect and grant mcp:write to enable supported changes.",
        [MCP_READ, MCP_WRITE],
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
    createHealthMcpServer(
      { tokenProvider },
      {
        remoteAuthorization: {
          mcpScopes,
          googleHealthScopes: props.googleScopes,
          requestedGoogleScopes: props.requestedGoogleScopes ?? [],
          resourceMetadataUrl: `${new URL(env.MCP_RESOURCE).origin}/.well-known/oauth-protected-resource/mcp`,
        },
      },
    ),
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
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const response = await createProvider(env).fetch(request, env, ctx);
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/oauth-protected-resource/mcp")
      return advertiseSupportedMcpScopes(response);
    return response;
  },
};
