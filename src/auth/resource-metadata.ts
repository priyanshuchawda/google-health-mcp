const MCP_READ = "mcp:read";
const MCP_WRITE = "mcp:write";

/** Publish the scopes this protected resource can authorize, including step-up. */
export async function advertiseSupportedMcpScopes(
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;
  const metadata = (await response.json()) as Record<string, unknown>;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({ ...metadata, scopes_supported: [MCP_READ, MCP_WRITE] }),
    { status: response.status, headers },
  );
}
