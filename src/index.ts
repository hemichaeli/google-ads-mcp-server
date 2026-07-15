import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "http";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Google Ads MCP Server - OAuth (refresh-token) architecture, all tools.
// esbuild-bundled to dist/index.js. Node 20, ESM.
// ---------------------------------------------------------------------------

const VERSION = "2.1.0";
const API_VERSION = "v21";
const BASE = `https://googleads.googleapis.com/${API_VERSION}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/adwords";

const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || "";
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  "https://google-ads-mcp-server-production-be4d.up.railway.app";
const REDIRECT_URI = `${PUBLIC_URL}/oauth/callback`;

type Account = {
  email: string;
  customer_id: string;
  refresh_token?: string;
  login_customer_id?: string | null;
};

function loadAccounts(): Account[] {
  try {
    const raw = process.env.GOOGLE_ADS_ACCOUNTS;
    if (!raw) return [];
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

const cidOf = (v: unknown) => String(v ?? "").replace(/-/g, "").trim();

function resolveAccount(emailOrId?: string): Account | undefined {
  const accts = loadAccounts();
  if (!emailOrId) return undefined;
  let a = accts.find((v) => v.email === emailOrId);
  if (a) return a;
  const cid = cidOf(emailOrId);
  return accts.find((v) => cidOf(v.customer_id) === cid);
}

// -- OAuth token cache (per refresh_token) ----------------------------------
const tokenCache = new Map<string, { token: string; exp: number }>();

async function accessTokenFor(refreshToken: string): Promise<string> {
  const now = Date.now();
  const c = tokenCache.get(refreshToken);
  if (c && c.exp > now + 60_000) return c.token;
  if (!CLIENT_ID || !CLIENT_SECRET)
    throw new Error("GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET not set.");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token)
    throw new Error(`Token refresh failed: ${JSON.stringify(j)}`);
  tokenCache.set(refreshToken, {
    token: j.access_token,
    exp: now + (j.expires_in ? j.expires_in * 1000 : 3_300_000),
  });
  return j.access_token;
}

// -- Core Google Ads REST call ----------------------------------------------
async function adsFetch(
  acct: Account,
  method: string,
  url: string,
  body?: any,
  loginOverride?: string | null
): Promise<any> {
  if (!acct.refresh_token)
    throw new Error(`Account ${acct.email} has no refresh_token configured.`);
  const doCall = async () => {
    const token = await accessTokenFor(acct.refresh_token!);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "developer-token": DEVELOPER_TOKEN,
      "Content-Type": "application/json",
    };
    const lc = loginOverride ?? acct.login_customer_id;
    if (lc) headers["login-customer-id"] = cidOf(lc);
    const r = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      j = text;
    }
    return { ok: r.ok, status: r.status, j };
  };
  let res = await doCall();
  // One retry on auth failure with a forced token refresh.
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    tokenCache.delete(acct.refresh_token!);
    res = await doCall();
  }
  if (!res.ok)
    throw new Error(
      `Google Ads API ${res.status}: ${typeof res.j === "string" ? res.j : JSON.stringify(res.j)}`
    );
  return res.j;
}

// Call scoped to a customer id, resolving the auth account by email or id.
async function cust(
  email: string | undefined,
  customerId: string,
  path: string,
  method = "POST",
  body?: any,
  login?: string
): Promise<any> {
  const acct = resolveAccount(email) || resolveAccount(customerId);
  if (!acct)
    throw new Error(
      `No account for ${email || customerId}. Call ads_list_accounts / configure GOOGLE_ADS_ACCOUNTS.`
    );
  return adsFetch(acct, method, `${BASE}/customers/${cidOf(customerId)}${path}`, body, login);
}

async function gaql(email: string | undefined, customerId: string, query: string) {
  const j = await cust(email, customerId, "/googleAds:search", "POST", { query });
  return j.results ?? j;
}

const ok = (o: any) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});
const fail = (e: any) => ({
  content: [{ type: "text" as const, text: String(e?.message ?? e) }],
  isError: true,
});

// -- OAuth re-auth (state -> captured refresh token) ------------------------
const oauthResults = new Map<string, any>();

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------
function registerTools(s: McpServer) {
  const acctArgs = {
    email: z.string().optional().describe("Account email (as configured). Optional if customer_id is unique."),
    customer_id: z.string().describe("Google Ads customer id (dashes allowed)."),
  };

  s.tool("ads_list_accounts", "List configured Google Ads accounts (email, customer_id, login_customer_id).", {}, async () => {
    try {
      return ok(loadAccounts().map((a) => ({ email: a.email, customer_id: a.customer_id, login_customer_id: a.login_customer_id ?? null })));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_list_accessible_customers", "List customer ids the authenticated user can access.", { email: z.string().optional() }, async ({ email }) => {
    try {
      const acct = resolveAccount(email) || loadAccounts()[0];
      if (!acct) throw new Error("No accounts configured.");
      const j = await adsFetch(acct, "GET", `${BASE}/customers:listAccessibleCustomers`);
      return ok(j);
    } catch (e) { return fail(e); }
  });

  s.tool("ads_get_customer_info", "Get basic info for a customer.", acctArgs, async ({ email, customer_id }) => {
    try { return ok(await gaql(email, customer_id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer")); }
    catch (e) { return fail(e); }
  });

  s.tool("ads_run_gaql_query", "Run any GAQL query (universal read).", { ...acctArgs, query: z.string().describe("A Google Ads Query Language query.") }, async ({ email, customer_id, query }) => {
    try { return ok(await gaql(email, customer_id, query)); } catch (e) { return fail(e); }
  });

  s.tool("ads_list_campaigns", "List non-removed campaigns.", acctArgs, async ({ email, customer_id }) => {
    try { return ok(await gaql(email, customer_id, "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id")); } catch (e) { return fail(e); }
  });

  s.tool("ads_list_ad_groups", "List ad groups, optionally filtered by campaign_id.", { ...acctArgs, campaign_id: z.string().optional() }, async ({ email, customer_id, campaign_id }) => {
    try {
      const w = campaign_id ? ` AND campaign.id = ${cidOf(campaign_id)}` : "";
      return ok(await gaql(email, customer_id, `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED'${w} ORDER BY ad_group.id`));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_list_ads", "List ads with approval status, optionally by ad_group_id.", { ...acctArgs, ad_group_id: z.string().optional() }, async ({ email, customer_id, ad_group_id }) => {
    try {
      const w = ad_group_id ? ` AND ad_group.id = ${cidOf(ad_group_id)}` : "";
      return ok(await gaql(email, customer_id, `SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group.id, campaign.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'${w}`));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_list_keywords", "List keywords for a customer (optionally by ad_group_id).", { ...acctArgs, ad_group_id: z.string().optional() }, async ({ email, customer_id, ad_group_id }) => {
    try {
      const w = ad_group_id ? ` AND ad_group.id = ${cidOf(ad_group_id)}` : "";
      return ok(await gaql(email, customer_id, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative, ad_group.id FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED'${w}`));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_list_budgets", "List campaign budgets.", acctArgs, async ({ email, customer_id }) => {
    try { return ok(await gaql(email, customer_id, "SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.status FROM campaign_budget WHERE campaign_budget.status != 'REMOVED'")); } catch (e) { return fail(e); }
  });

  s.tool("ads_list_conversion_actions", "List conversion actions (id, name, category, status).", acctArgs, async ({ email, customer_id }) => {
    try { return ok(await gaql(email, customer_id, "SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.status, conversion_action.type FROM conversion_action")); } catch (e) { return fail(e); }
  });

  s.tool("ads_get_campaign_performance", "Campaign metrics over a date range (default LAST_7_DAYS).", { ...acctArgs, date_range: z.string().optional().describe("e.g. TODAY, YESTERDAY, LAST_7_DAYS, LAST_30_DAYS") }, async ({ email, customer_id, date_range }) => {
    try {
      const dr = (date_range || "LAST_7_DAYS").toUpperCase();
      return ok(await gaql(email, customer_id, `SELECT campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.average_cpc, metrics.search_impression_share FROM campaign WHERE segments.date DURING ${dr} AND campaign.status = 'ENABLED'`));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_get_search_terms_report", "Search terms report over a date range.", { ...acctArgs, campaign_id: z.string().optional(), date_range: z.string().optional(), limit: z.number().optional() }, async ({ email, customer_id, campaign_id, date_range, limit }) => {
    try {
      const dr = (date_range || "LAST_7_DAYS").toUpperCase();
      const w = campaign_id ? ` AND campaign.id = ${cidOf(campaign_id)}` : "";
      const lim = limit && limit > 0 ? Math.min(limit, 500) : 50;
      return ok(await gaql(email, customer_id, `SELECT search_term_view.search_term, segments.ad_network_type, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING ${dr}${w} ORDER BY metrics.clicks DESC LIMIT ${lim}`));
    } catch (e) { return fail(e); }
  });

  // -- Writes ----------------------------------------------------------------
  s.tool(
    "ads_create_ad",
    "Create a responsive search ad (RSA) in an ad group. status is set on the AdGroupAd (not the ad).",
    {
      ...acctArgs,
      ad_group_id: z.string(),
      headlines: z.array(z.string()).min(3).describe("3-15 headlines, <=30 chars each."),
      descriptions: z.array(z.string()).min(2).describe("2-4 descriptions, <=90 chars each."),
      final_urls: z.array(z.string()).min(1),
      pinned_headline: z.string().optional().describe("If given, this headline text is pinned to position 1."),
      status: z.enum(["ENABLED", "PAUSED"]).optional().default("ENABLED"),
    },
    async ({ email, customer_id, ad_group_id, headlines, descriptions, final_urls, pinned_headline, status }) => {
      try {
        const cid = cidOf(customer_id);
        const hAssets = headlines.map((t) =>
          pinned_headline && t === pinned_headline ? { text: t, pinnedField: "HEADLINE_1" } : { text: t }
        );
        const dAssets = descriptions.map((t) => ({ text: t }));
        const op = {
          create: {
            adGroup: `customers/${cid}/adGroups/${cidOf(ad_group_id)}`,
            status: status || "ENABLED",
            ad: {
              finalUrls: final_urls,
              responsiveSearchAd: { headlines: hAssets, descriptions: dAssets },
            },
          },
        };
        return ok(await cust(email, customer_id, "/adGroupAds:mutate", "POST", { operations: [op] }));
      } catch (e) { return fail(e); }
    }
  );

  s.tool("ads_update_ad_status", "Enable/Pause/Remove an ad.", { ...acctArgs, ad_group_id: z.string(), ad_id: z.string(), status: z.enum(["ENABLED", "PAUSED", "REMOVED"]) }, async ({ email, customer_id, ad_group_id, ad_id, status }) => {
    try {
      const cid = cidOf(customer_id);
      const op = { update: { resourceName: `customers/${cid}/adGroupAds/${cidOf(ad_group_id)}~${cidOf(ad_id)}`, status }, updateMask: "status" };
      return ok(await cust(email, customer_id, "/adGroupAds:mutate", "POST", { operations: [op] }));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_add_negative_keywords", "Add negative keywords at campaign or ad_group level.", { ...acctArgs, level: z.enum(["campaign", "ad_group"]), level_id: z.string(), keywords: z.array(z.object({ text: z.string(), match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).optional() })) }, async ({ email, customer_id, level, level_id, keywords }) => {
    try {
      const cid = cidOf(customer_id);
      if (level === "campaign") {
        const ops = keywords.map((k) => ({ create: { campaign: `customers/${cid}/campaigns/${cidOf(level_id)}`, negative: true, keyword: { text: k.text, matchType: k.match_type || "BROAD" } } }));
        return ok(await cust(email, customer_id, "/campaignCriteria:mutate", "POST", { operations: ops }));
      }
      const ops = keywords.map((k) => ({ create: { adGroup: `customers/${cid}/adGroups/${cidOf(level_id)}`, negative: true, keyword: { text: k.text, matchType: k.match_type || "BROAD" } } }));
      return ok(await cust(email, customer_id, "/adGroupCriteria:mutate", "POST", { operations: ops }));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_add_keywords", "Add positive keywords to an ad group.", { ...acctArgs, ad_group_id: z.string(), keywords: z.array(z.object({ text: z.string(), match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).optional() })) }, async ({ email, customer_id, ad_group_id, keywords }) => {
    try {
      const cid = cidOf(customer_id);
      const ops = keywords.map((k) => ({ create: { adGroup: `customers/${cid}/adGroups/${cidOf(ad_group_id)}`, status: "ENABLED", keyword: { text: k.text, matchType: k.match_type || "BROAD" } } }));
      return ok(await cust(email, customer_id, "/adGroupCriteria:mutate", "POST", { operations: ops }));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_update_budget", "Set a campaign budget's daily amount (micros; $1 = 1000000).", { ...acctArgs, budget_id: z.string(), amount_micros: z.number() }, async ({ email, customer_id, budget_id, amount_micros }) => {
    try {
      const cid = cidOf(customer_id);
      const op = { update: { resourceName: `customers/${cid}/campaignBudgets/${cidOf(budget_id)}`, amountMicros: amount_micros }, updateMask: "amount_micros" };
      return ok(await cust(email, customer_id, "/campaignBudgets:mutate", "POST", { operations: [op] }));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_update_campaign", "Update a campaign's status and/or name.", { ...acctArgs, campaign_id: z.string(), status: z.enum(["ENABLED", "PAUSED", "REMOVED"]).optional(), name: z.string().optional() }, async ({ email, customer_id, campaign_id, status, name }) => {
    try {
      const cid = cidOf(customer_id);
      const update: any = { resourceName: `customers/${cid}/campaigns/${cidOf(campaign_id)}` };
      const masks: string[] = [];
      if (status) { update.status = status; masks.push("status"); }
      if (name) { update.name = name; masks.push("name"); }
      if (!masks.length) throw new Error("Provide status and/or name.");
      return ok(await cust(email, customer_id, "/campaigns:mutate", "POST", { operations: [{ update, updateMask: masks.join(",") }] }));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_set_search_partner_network", "Enable/disable the Search Partners network on a campaign.", { ...acctArgs, campaign_id: z.string(), enabled: z.boolean() }, async ({ email, customer_id, campaign_id, enabled }) => {
    try {
      const cid = cidOf(customer_id);
      const op = { update: { resourceName: `customers/${cid}/campaigns/${cidOf(campaign_id)}`, networkSettings: { targetPartnerSearchNetwork: enabled } }, updateMask: "network_settings.target_partner_search_network" };
      return ok(await cust(email, customer_id, "/campaigns:mutate", "POST", { operations: [op] }));
    } catch (e) { return fail(e); }
  });

  s.tool("ads_mutate", "Universal mutate: POST /{resource}:mutate with operations (advanced escape hatch).", { ...acctArgs, resource: z.string().describe("e.g. adGroupAds, campaigns, adGroupCriteria"), operations: z.array(z.any()) }, async ({ email, customer_id, resource, operations }) => {
    try { return ok(await cust(email, customer_id, `/${resource}:mutate`, "POST", { operations })); } catch (e) { return fail(e); }
  });

  // -- Manager (MCC) linking -------------------------------------------------
  // From the MANAGER account, send a link request to a client account.
  // Creates a PENDING CustomerClientLink. login-customer-id must be the manager.
  s.tool(
    "ads_link_account",
    "MCC: send a manager link request to a client account (creates a PENDING CustomerClientLink). The client must then accept (ads_accept_manager_link or the Google Ads UI). manager_customer_id = the MCC id; client_customer_id = the account to bring under management.",
    {
      email: z.string().optional().describe("Auth account email for the MANAGER (must be a user on the MCC)."),
      manager_customer_id: z.string().describe("The manager (MCC) customer id."),
      client_customer_id: z.string().describe("The client account customer id to link."),
    },
    async ({ email, manager_customer_id, client_customer_id }) => {
      try {
        const mgr = cidOf(manager_customer_id);
        const acct = resolveAccount(email) || resolveAccount(manager_customer_id);
        if (!acct) throw new Error(`No auth account for manager ${email || manager_customer_id}.`);
        // customerClientLinks:mutate uses a SINGULAR operation.
        const body = { operation: { create: { clientCustomer: `customers/${cidOf(client_customer_id)}`, status: "PENDING" } } };
        const j = await adsFetch(acct, "POST", `${BASE}/customers/${mgr}/customerClientLinks:mutate`, body, mgr);
        return ok({ sent: true, manager: mgr, client: cidOf(client_customer_id), result: j, next: "Accept the request from the client account (ads_accept_manager_link, or Google Ads UI > Admin > Access and security > Managers)." });
      } catch (e) { return fail(e); }
    }
  );

  // List link requests a MANAGER has sent (to find the manager_link_id for accepting).
  s.tool(
    "ads_list_manager_links",
    "List CustomerClientLinks a MANAGER account has (status + resourceName, so you can see pending/active links). Run against the MCC customer id.",
    { ...acctArgs },
    async ({ email, customer_id }) => {
      try {
        const cid = cidOf(customer_id);
        return ok(await adsFetch(resolveAccount(email) || resolveAccount(customer_id)!, "POST", `${BASE}/customers/${cid}/googleAds:search`, { query: "SELECT customer_client_link.client_customer, customer_client_link.status, customer_client_link.manager_link_id, customer_client_link.resource_name FROM customer_client_link" }, cid));
      } catch (e) { return fail(e); }
    }
  );

  // From the CLIENT account, accept (activate) a pending manager link.
  // Requires the client account to be authorized in GOOGLE_ADS_ACCOUNTS with its OWN token.
  s.tool(
    "ads_accept_manager_link",
    "CLIENT: accept/activate a pending manager link (sets the CustomerManagerLink status to ACTIVE). Requires the CLIENT account authorized in GOOGLE_ADS_ACCOUNTS with its own refresh_token. manager_link_id comes from ads_list_manager_links (run on the manager).",
    {
      email: z.string().optional().describe("Auth account email for the CLIENT account."),
      client_customer_id: z.string().describe("The client account customer id (the one being managed)."),
      manager_customer_id: z.string().describe("The manager (MCC) customer id."),
      manager_link_id: z.string().describe("The manager_link_id of the pending link."),
    },
    async ({ email, client_customer_id, manager_customer_id, manager_link_id }) => {
      try {
        const cc = cidOf(client_customer_id);
        const acct = resolveAccount(email) || resolveAccount(client_customer_id);
        if (!acct) throw new Error(`No auth account for client ${email || client_customer_id}.`);
        const rn = `customers/${cc}/customerManagerLinks/${cidOf(manager_customer_id)}~${cidOf(manager_link_id)}`;
        // customerManagerLinks:mutate uses operations (plural). login-customer-id = the client itself.
        const body = { operations: [{ update: { resourceName: rn, status: "ACTIVE" }, updateMask: "status" }] };
        const j = await adsFetch(acct, "POST", `${BASE}/customers/${cc}/customerManagerLinks:mutate`, body, cc);
        return ok({ accepted: true, client: cc, result: j });
      } catch (e) { return fail(e); }
    }
  );

  // -- OAuth re-auth helpers -------------------------------------------------
  s.tool("ads_get_oauth_url", "Get a Google OAuth consent URL to (re)authorize an account. Approve, then call ads_poll_oauth_result with the same state.", { state: z.string().describe("A unique state string you choose.") }, async ({ state }) => {
    try {
      const u = new URL(AUTH_URL);
      u.searchParams.set("client_id", CLIENT_ID);
      u.searchParams.set("redirect_uri", REDIRECT_URI);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SCOPE);
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("state", state);
      return ok(`Visit this URL signed in with the target Google Ads account, approve, then call ads_poll_oauth_result with state="${state}":\n\n${u.toString()}`);
    } catch (e) { return fail(e); }
  });

  s.tool("ads_poll_oauth_result", "Retrieve the refresh_token captured after an OAuth approval for a given state.", { state: z.string() }, async ({ state }) => {
    try {
      const r = oauthResults.get(state);
      if (!r) return ok({ status: "pending", message: "Not authorized yet. Approve the OAuth URL first." });
      return ok({ status: "ok", message: "Paste this refresh_token into the matching account in GOOGLE_ADS_ACCOUNTS.", ...r });
    } catch (e) { return fail(e); }
  });
}

// ---------------------------------------------------------------------------
// Transport wiring: Streamable HTTP (/mcp) + legacy SSE (/sse) + health + oauth
// ---------------------------------------------------------------------------
function buildServer(): McpServer {
  const s = new McpServer({ name: "google-ads-mcp-server", version: VERSION });
  registerTools(s);
  return s;
}

const streamable: Record<string, StreamableHTTPServerTransport> = {};
const sse: Record<string, SSEServerTransport> = {};

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : undefined); } catch { resolve(undefined); } });
    req.on("error", () => resolve(undefined));
  });
}
const isInit = (b: any) => b && (Array.isArray(b) ? b.some((x) => x?.method === "initialize") : b.method === "initialize");

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", PUBLIC_URL);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "google-ads-mcp-server", version: VERSION, accounts: loadAccounts().length }));
      return;
    }

    if (url.pathname === "/oauth/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || "";
      if (!code) { res.writeHead(400); res.end("Missing code"); return; }
      try {
        const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" });
        const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
        const j: any = await r.json().catch(() => ({}));
        if (j.refresh_token) oauthResults.set(state, { refresh_token: j.refresh_token });
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h1>${j.refresh_token ? "✅ Authorization Successful!" : "⚠️ No refresh token returned"}</h1><p>You can close this tab and return to Claude.</p><p style="color:#888">State: ${state}</p></body></html>`);
      } catch (e: any) { res.writeHead(500); res.end("OAuth exchange failed: " + e?.message); }
      return;
    }

    // Streamable HTTP
    if (url.pathname === "/mcp") {
      if (req.method === "POST") {
        const sid = req.headers["mcp-session-id"] as string | undefined;
        let transport = sid ? streamable[sid] : undefined;
        const body = await readBody(req);
        if (!transport) {
          if (isInit(body)) {
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id: string) => { streamable[id] = transport!; },
            });
            transport.onclose = () => { if (transport!.sessionId) delete streamable[transport!.sessionId]; };
            await buildServer().connect(transport);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session id" }, id: null }));
            return;
          }
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const sid = req.headers["mcp-session-id"] as string | undefined;
        const transport = sid ? streamable[sid] : undefined;
        if (!transport) { res.writeHead(400); res.end("No session"); return; }
        await transport.handleRequest(req, res);
        return;
      }
    }

    // Legacy SSE
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      sse[transport.sessionId] = transport;
      res.on("close", () => { delete sse[transport.sessionId]; });
      await buildServer().connect(transport);
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      const sid = url.searchParams.get("sessionId") || "";
      const transport = sse[sid];
      if (!transport) { res.writeHead(400); res.end("No SSE session"); return; }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404); res.end("Not Found");
  } catch (e: any) {
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); }
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

httpServer.listen(Number(process.env.PORT) || 3000, () => {
  console.log(`✅ Google Ads MCP Server v${VERSION} (OAuth) on port ${process.env.PORT || 3000}`);
  console.log(`✅ Accounts configured: ${loadAccounts().length}`);
  console.log(`✅ Transports: /mcp (streamable), /sse (legacy), /health, /oauth/callback`);
});
