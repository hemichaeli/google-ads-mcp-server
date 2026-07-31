import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const AUTH_SECRET = process.env.AUTH_SECRET || "";
export const authEnabled = AUTH_SECRET.length > 0;

// SERVER_ID must be the same slug used as clientPrefix for this server.
// It is mixed into the token derivation ON PURPOSE: it domain-separates the tokens so a
// bearer token minted for one server is useless against any other, even if two servers were
// accidentally given the same AUTH_SECRET. Do not remove it and do not make it generic.
const SERVER_ID = "google-ads-mcp";

const derive = (suffix: string) =>
  crypto.createHash("sha256").update(`${AUTH_SECRET}|${SERVER_ID}|${suffix}`).digest("hex");

const ACCESS_TOKEN = authEnabled ? derive("mcp-access") : "";
const REFRESH_TOKEN = authEnabled ? derive("mcp-refresh") : "";

// one-time authorization codes: code -> expiry epoch ms
const codes = new Map<string, number>();
const CODE_TTL_MS = 10 * 60 * 1000;

function issueCode(): string {
  const code = crypto.randomBytes(32).toString("hex");
  codes.set(code, Date.now() + CODE_TTL_MS);
  return code;
}

function consumeCode(code: string): boolean {
  const exp = codes.get(code);
  if (exp === undefined) return false;
  codes.delete(code);
  return exp > Date.now();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function form(redirectUri: string, state: string, error?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Connect</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaed;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}form{background:#151922;
padding:32px;border-radius:12px;width:320px}h1{font-size:16px;margin:0 0 4px}
p{font-size:13px;color:#9aa4b2;margin:0 0 20px}input{width:100%;box-sizing:border-box;
padding:10px;border-radius:8px;border:1px solid #2a3140;background:#0b0d12;color:#e8eaed;
font-size:14px}button{width:100%;margin-top:12px;padding:10px;border:0;border-radius:8px;
background:#4c8bf5;color:#fff;font-size:14px;cursor:pointer}
.e{color:#ff6b6b;font-size:13px;margin-top:12px}</style></head><body>
<form method="POST" action="/authorize">
<h1>MCP server access</h1><p>Enter the shared passphrase to connect.</p>
<input type="password" name="passphrase" autofocus required placeholder="Passphrase">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<button type="submit">Connect</button>
${error ? `<div class="e">${escapeHtml(error)}</div>` : ""}
</form></body></html>`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function redirectBack(res: ServerResponse, redirectUri: string, state: string): void {
  const loc = new URL(redirectUri);
  loc.searchParams.set("code", issueCode());
  if (state) loc.searchParams.set("state", state);
  res.writeHead(302, { Location: loc.toString(), "Cache-Control": "no-store" });
  res.end();
}

// The entry file's readBody() JSON.parses and discards the raw text, which cannot carry an
// application/x-www-form-urlencoded body (/authorize POST, /token). This reads the raw text
// once; JSON endpoints parse it here.
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
}

const timingSafeEqualStr = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Gate for the MCP transport endpoints. Always true when AUTH_SECRET is unset. */
export function checkBearer(req: IncomingMessage): boolean {
  if (!authEnabled) return true;
  const header = (req.headers.authorization as string | undefined) || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return timingSafeEqualStr(token, ACCESS_TOKEN);
}

/** 401 + WWW-Authenticate pointing at the resource metadata, which starts Claude's OAuth flow. */
export function sendUnauthorized(res: ServerResponse, baseUrl: string): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
  );
  sendJson(res, 401, { error: "invalid_token" });
}

/**
 * OAuth 2.1 discovery + DCR + authorize/token for native http servers.
 * Returns true if it handled the request, false if the caller should keep routing.
 */
export async function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: { baseUrl: string; clientPrefix: string }
): Promise<boolean> {
  const { baseUrl, clientPrefix } = opts;
  const method = req.method || "GET";
  const path = url.pathname;

  if (
    method === "GET" &&
    (path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/sse" ||
      path === "/.well-known/oauth-protected-resource/mcp")
  ) {
    sendJson(res, 200, {
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
    return true;
  }

  if (
    method === "GET" &&
    (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")
  ) {
    sendJson(res, 200, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
    return true;
  }

  if (method === "POST" && path === "/register") {
    const raw = await readRawBody(req);
    let meta: Record<string, unknown> = {};
    try {
      meta = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    sendJson(res, 201, {
      client_id: `${clientPrefix}-client`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
    });
    return true;
  }

  if (method === "GET" && path === "/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const state = url.searchParams.get("state") || "";
    if (!redirectUri) {
      sendJson(res, 400, { error: "invalid_request", error_description: "redirect_uri required" });
      return true;
    }
    if (!authEnabled) {
      redirectBack(res, redirectUri, state);
      return true;
    }
    sendHtml(res, 200, form(redirectUri, state));
    return true;
  }

  if (method === "POST" && path === "/authorize") {
    const body = new URLSearchParams(await readRawBody(req));
    const redirectUri = body.get("redirect_uri") || "";
    const state = body.get("state") || "";
    if (!redirectUri) {
      sendJson(res, 400, { error: "invalid_request", error_description: "redirect_uri required" });
      return true;
    }
    if (!authEnabled) {
      redirectBack(res, redirectUri, state);
      return true;
    }
    if (!timingSafeEqualStr(body.get("passphrase") || "", AUTH_SECRET)) {
      sendHtml(res, 401, form(redirectUri, state, "Incorrect passphrase."));
      return true;
    }
    redirectBack(res, redirectUri, state);
    return true;
  }

  if (method === "POST" && path === "/token") {
    const raw = await readRawBody(req);
    const body = new URLSearchParams(raw);
    if (authEnabled) {
      const grant = body.get("grant_type") || "authorization_code";
      const valid =
        grant === "refresh_token"
          ? body.get("refresh_token") === REFRESH_TOKEN
          : consumeCode(body.get("code") || "");
      if (!valid) {
        sendJson(res, 400, { error: "invalid_grant" });
        return true;
      }
    }
    sendJson(res, 200, {
      access_token: authEnabled ? ACCESS_TOKEN : `${clientPrefix}-token`,
      token_type: "Bearer",
      expires_in: 315360000,
      refresh_token: authEnabled ? REFRESH_TOKEN : `${clientPrefix}-refresh`,
      scope: "mcp",
    });
    return true;
  }

  return false;
}
