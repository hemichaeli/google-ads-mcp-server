import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";
import { randomUUID } from "crypto";

const API_VERSION = "v20";
const BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;
const TOKEN_URL = "https://www.googleapis.com/oauth2/v3/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/adwords";

const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || "";

function getAccounts(): Record<string, { refresh_token: string; customer_id: string; login_customer_id?: string }> {
  try {
    return JSON.parse(process.env.GOOGLE_ADS_ACCOUNTS || "{}");
  } catch { return {}; }
}

const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

async function getAccessToken(email: string): Promise<string> {
  const cached = tokenCache[email];
  if (cached && Date.now() < cached.expires_at - 60000) return cached.access_token;
  const account = getAccounts()[email];
  if (!account) throw new Error(`No account for email: ${email}. Call ads_list_accounts.`);
  const params = new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: account.refresh_token });
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache[email] = { access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

function buildHeaders(token: string, loginCid?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", "developer-token": DEVELOPER_TOKEN, "Authorization": `Bearer ${token}` };
  if (loginCid) h["login-customer-id"] = loginCid.replace(/-/g, "");
  return h;
}

async function gaql(email: string, cid: string, query: string, lcid?: string): Promise<unknown[]> {
  const token = await getAccessToken(email);
  const res = await fetch(`${BASE_URL}/customers/${cid.replace(/-/g, "")}/googleAds:search`, { method: "POST", headers: buildHeaders(token, lcid), body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`GAQL failed ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { results?: unknown[] }).results || [];
}

async function apiGet(email: string, path: string, lcid?: string): Promise<unknown> {
  const token = await getAccessToken(email);
  const res = await fetch(`${BASE_URL}/${path}`, { method: "GET", headers: buildHeaders(token, lcid) });
  if (!res.ok) throw new Error(`GET failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(email: string, path: string, body: unknown, lcid?: string): Promise<unknown> {
  const token = await getAccessToken(email);
  const res = await fetch(`${BASE_URL}/${path}`, { method: "POST", headers: buildHeaders(token, lcid), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST failed ${res.status}: ${await res.text()}`);
  return res.json();
}

const m2c = (v: number | string) => (Number(v) / 1_000_000).toFixed(2);
const pct = (v: unknown) => ((Number(v) || 0) * 100).toFixed(2) + "%";
const lcid = (email: string, override?: string) => override || getAccounts()[email]?.login_customer_id;

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "google-ads-mcp-server", version: "1.0.0" });

  // ── ACCOUNTS ──────────────────────────────────────────────────────────────

  server.registerTool("ads_list_accounts", {
    title: "List Configured Accounts",
    description: "List all Google Ads accounts configured in this MCP server (by email/customer_id). Always call this first.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const accs = getAccounts();
    const rows = Object.entries(accs).map(([email, v]) => ({ email, customer_id: v.customer_id, login_customer_id: v.login_customer_id || null }));
    return { content: [{ type: "text", text: rows.length ? JSON.stringify(rows, null, 2) : "No accounts configured. Set GOOGLE_ADS_ACCOUNTS env var." }] };
  });

  server.registerTool("ads_list_accessible_customers", {
    title: "List Accessible Customers",
    description: "List all Google Ads customer resource names accessible by this OAuth credential.",
    inputSchema: { email: z.string().describe("Authenticated email") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email }) => {
    const data = await apiGet(email, "customers:listAccessibleCustomers") as { resourceNames?: string[] };
    return { content: [{ type: "text", text: JSON.stringify(data.resourceNames || [], null, 2) }] };
  });

  server.registerTool("ads_get_customer_info", {
    title: "Get Customer Info",
    description: "Get basic info (name, currency, timezone, status, manager flag) for a customer account.",
    inputSchema: { email: z.string(), customer_id: z.string(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, login_customer_id }) => {
    const r = await gaql(email, customer_id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager, customer.test_account FROM customer LIMIT 1", lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r[0] || {}, null, 2) }] };
  });

  // ── CAMPAIGNS ─────────────────────────────────────────────────────────────

  server.registerTool("ads_list_campaigns", {
    title: "List Campaigns",
    description: "List campaigns with status, budget, and performance metrics.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      date_range: z.enum(["TODAY","YESTERDAY","LAST_7_DAYS","LAST_14_DAYS","LAST_30_DAYS","THIS_MONTH","LAST_MONTH","LAST_90_DAYS"]).default("LAST_30_DAYS"),
      status_filter: z.enum(["ALL","ENABLED","PAUSED","REMOVED"]).default("ALL"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, date_range, status_filter, login_customer_id }) => {
    const statusClause = status_filter !== "ALL" ? `AND campaign.status = '${status_filter}'` : "AND campaign.status != 'REMOVED'";
    const r = await gaql(email, customer_id,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
       campaign_budget.amount_micros, metrics.clicks, metrics.impressions, metrics.ctr,
       metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value,
       campaign.bidding_strategy_type, campaign.optimization_score
       FROM campaign WHERE 1=1 ${statusClause} AND segments.date DURING ${date_range}
       ORDER BY metrics.cost_micros DESC`,
      lcid(email, login_customer_id));
    const out = r.map((row: unknown) => {
      const x = row as Record<string, Record<string, unknown>>;
      return { id: x.campaign?.id, name: x.campaign?.name, status: x.campaign?.status, type: x.campaign?.advertisingChannelType, budget: m2c(x.campaignBudget?.amountMicros as number || 0), clicks: x.metrics?.clicks, impressions: x.metrics?.impressions, ctr: pct(x.metrics?.ctr), avg_cpc: m2c(x.metrics?.averageCpc as number || 0), cost: m2c(x.metrics?.costMicros as number || 0), conversions: x.metrics?.conversions, conv_value: m2c(x.metrics?.conversionsValue as number || 0), optimization_score: x.campaign?.optimizationScore };
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  server.registerTool("ads_get_campaign_performance", {
    title: "Get Campaign Performance",
    description: "Detailed metrics for one campaign, optionally segmented by day, device, or network.",
    inputSchema: {
      email: z.string(), customer_id: z.string(), campaign_id: z.string(),
      date_range: z.enum(["LAST_7_DAYS","LAST_14_DAYS","LAST_30_DAYS","THIS_MONTH","LAST_MONTH","LAST_90_DAYS"]).default("LAST_30_DAYS"),
      segment_by: z.enum(["none","day","device","network"]).default("none"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, date_range, segment_by, login_customer_id }) => {
    const seg = segment_by === "day" ? ", segments.date" : segment_by === "device" ? ", segments.device" : segment_by === "network" ? ", segments.ad_network_type" : "";
    const r = await gaql(email, customer_id,
      `SELECT campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.ctr,
       metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value,
       metrics.search_impression_share, metrics.search_budget_lost_impression_share,
       metrics.search_rank_lost_impression_share, metrics.all_conversions,
       metrics.view_through_conversions${seg}
       FROM campaign WHERE campaign.id = ${campaign_id} AND segments.date DURING ${date_range}`,
      lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_create_campaign", {
    title: "Create Campaign",
    description: "Create a new campaign with budget. Starts PAUSED by default.",
    inputSchema: {
      email: z.string(), customer_id: z.string(), name: z.string(),
      campaign_type: z.enum(["SEARCH","DISPLAY","SHOPPING","VIDEO","PERFORMANCE_MAX"]).default("SEARCH"),
      daily_budget_micros: z.number().describe("Daily budget in micros (10000000 = $10)"),
      bidding_strategy: z.enum(["MANUAL_CPC","TARGET_CPA","TARGET_ROAS","MAXIMIZE_CONVERSIONS","MAXIMIZE_CONVERSION_VALUE","TARGET_IMPRESSION_SHARE"]).default("MAXIMIZE_CONVERSIONS"),
      status: z.enum(["ENABLED","PAUSED"]).default("PAUSED"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ email, customer_id, name, campaign_type, daily_budget_micros, bidding_strategy, status, login_customer_id }) => {
    const l = lcid(email, login_customer_id);
    const cid = customer_id.replace(/-/g, "");
    const br = await apiPost(email, `customers/${cid}/campaignBudgets:mutate`, { operations: [{ create: { name: `Budget for ${name}`, amountMicros: daily_budget_micros, deliveryMethod: "STANDARD" } }] }, l) as { results?: Array<{ resourceName: string }> };
    const budgetName = br.results?.[0]?.resourceName;
    if (!budgetName) throw new Error("Budget creation failed");
    const bid: Record<string, unknown> = {};
    if (bidding_strategy === "MANUAL_CPC") bid.manualCpc = { enhancedCpcEnabled: true };
    else if (bidding_strategy === "MAXIMIZE_CONVERSIONS") bid.maximizeConversions = {};
    else if (bidding_strategy === "MAXIMIZE_CONVERSION_VALUE") bid.maximizeConversionValue = {};
    else if (bidding_strategy === "TARGET_CPA") bid.targetCpa = {};
    else if (bidding_strategy === "TARGET_ROAS") bid.targetRoas = {};
    const r = await apiPost(email, `customers/${cid}/campaigns:mutate`, { operations: [{ create: { name, status, advertisingChannelType: campaign_type, campaignBudget: budgetName, ...bid } }] }, l);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_update_campaign", {
    title: "Update Campaign",
    description: "Update campaign name, status, or bidding strategy.",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string(), status: z.enum(["ENABLED","PAUSED"]).optional(), name: z.string().optional(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, status, name, login_customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const upd: Record<string, unknown> = { resourceName: `customers/${cid}/campaigns/${campaign_id}` };
    const mask: string[] = [];
    if (status) { upd.status = status; mask.push("status"); }
    if (name) { upd.name = name; mask.push("name"); }
    const r = await apiPost(email, `customers/${cid}/campaigns:mutate`, { operations: [{ update: upd, updateMask: mask.join(",") }] }, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── AD GROUPS ─────────────────────────────────────────────────────────────

  server.registerTool("ads_list_ad_groups", {
    title: "List Ad Groups",
    description: "List ad groups with performance metrics. Optionally filter by campaign.",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string().optional(), date_range: z.enum(["LAST_7_DAYS","LAST_30_DAYS","THIS_MONTH","LAST_MONTH","LAST_90_DAYS"]).default("LAST_30_DAYS"), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, date_range, login_customer_id }) => {
    const cf = campaign_id ? `AND campaign.id = ${campaign_id}` : "";
    const r = await gaql(email, customer_id, `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM ad_group WHERE ad_group.status != 'REMOVED' ${cf} AND segments.date DURING ${date_range} ORDER BY metrics.cost_micros DESC`, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_create_ad_group", {
    title: "Create Ad Group",
    description: "Create a new ad group inside a campaign.",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string(), name: z.string(), cpc_bid_micros: z.number().optional().describe("CPC bid in micros"), status: z.enum(["ENABLED","PAUSED"]).default("ENABLED"), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, name, cpc_bid_micros, status, login_customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const create: Record<string, unknown> = { name, status, campaign: `customers/${cid}/campaigns/${campaign_id}` };
    if (cpc_bid_micros) create.cpcBidMicros = cpc_bid_micros;
    const r = await apiPost(email, `customers/${cid}/adGroups:mutate`, { operations: [{ create }] }, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_update_ad_group", {
    title: "Update Ad Group",
    description: "Update ad group status, name, or CPC bid.",
    inputSchema: { email: z.string(), customer_id: z.string(), ad_group_id: z.string(), status: z.enum(["ENABLED","PAUSED"]).optional(), name: z.string().optional(), cpc_bid_micros: z.number().optional(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, ad_group_id, status, name, cpc_bid_micros, login_customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const upd: Record<string, unknown> = { resourceName: `customers/${cid}/adGroups/${ad_group_id}` };
    const mask: string[] = [];
    if (status) { upd.status = status; mask.push("status"); }
    if (name) { upd.name = name; mask.push("name"); }
    if (cpc_bid_micros) { upd.cpcBidMicros = cpc_bid_micros; mask.push("cpc_bid_micros"); }
    const r = await apiPost(email, `customers/${cid}/adGroups:mutate`, { operations: [{ update: upd, updateMask: mask.join(",") }] }, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── ADS ───────────────────────────────────────────────────────────────────

  server.registerTool("ads_list_ads", {
    title: "List Ads",
    description: "List ads (responsive search ads, etc.) with performance. Filter by campaign or ad group.",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string().optional(), ad_group_id: z.string().optional(), date_range: z.enum(["LAST_7_DAYS","LAST_30_DAYS","THIS_MONTH","LAST_MONTH"]).default("LAST_30_DAYS"), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, ad_group_id, date_range, login_customer_id }) => {
    const filters = ["ad_group_ad.status != 'REMOVED'"];
    if (campaign_id) filters.push(`campaign.id = ${campaign_id}`);
    if (ad_group_id) filters.push(`ad_group.id = ${ad_group_id}`);
    const r = await gaql(email, customer_id, `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group.id, ad_group.name, campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions FROM ad_group_ad WHERE ${filters.join(" AND ")} AND segments.date DURING ${date_range} ORDER BY metrics.cost_micros DESC`, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_update_ad_status", {
    title: "Update Ad Status",
    description: "Pause or enable a specific ad.",
    inputSchema: { email: z.string(), customer_id: z.string(), ad_group_id: z.string(), ad_id: z.string(), status: z.enum(["ENABLED","PAUSED"]), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, ad_group_id, ad_id, status, login_customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const r = await apiPost(email, `customers/${cid}/adGroupAds:mutate`, { operations: [{ update: { resourceName: `customers/${cid}/adGroupAds/${ad_group_id}~${ad_id}`, status }, updateMask: "status" }] }, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── KEYWORDS ──────────────────────────────────────────────────────────────

  server.registerTool("ads_list_keywords", {
    title: "List Keywords",
    description: "List keywords with bids, quality scores, and performance metrics.",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string().optional(), ad_group_id: z.string().optional(), date_range: z.enum(["LAST_7_DAYS","LAST_30_DAYS","THIS_MONTH","LAST_MONTH","LAST_90_DAYS"]).default("LAST_30_DAYS"), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, ad_group_id, date_range, login_customer_id }) => {
    const filters = ["ad_group_criterion.status != 'REMOVED'", "ad_group_criterion.type = 'KEYWORD'"];
    if (campaign_id) filters.push(`campaign.id = ${campaign_id}`);
    if (ad_group_id) filters.push(`ad_group.id = ${ad_group_id}`);
    const r = await gaql(email, customer_id, `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.quality_info.quality_score, ad_group.id, ad_group.name, campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.search_impression_share FROM ad_group_criterion WHERE ${filters.join(" AND ")} AND segments.date DURING ${date_range} ORDER BY metrics.cost_micros DESC`, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_add_keywords", {
    title: "Add Keywords",
    description: "Add keywords to an ad group.",
    inputSchema: { email: z.string(), customer_id: z.string(), ad_group_id: z.string(), keywords: z.array(z.object({ text: z.string(), match_type: z.enum(["EXACT","PHRASE","BROAD"]), cpc_bid_micros: z.number().optional() })), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ email, customer_id, ad_group_id, keywords, login_customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const ops = keywords.map(kw => ({ create: { adGroup: `customers/${cid}/adGroups/${ad_group_id}`, status: "ENABLED", keyword: { text: kw.text, matchType: kw.match_type }, ...(kw.cpc_bid_micros ? { cpcBidMicros: kw.cpc_bid_micros } : {}) } }));
    const r = await apiPost(email, `customers/${cid}/adGroupCriteria:mutate`, { operations: ops }, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_add_negative_keywords", {
    title: "Add Negative Keywords",
    description: "Add negative keywords at campaign level or ad group level.",
    inputSchema: { email: z.string(), customer_id: z.string(), level: z.enum(["campaign","ad_group"]), level_id: z.string().describe("Campaign ID or Ad Group ID"), keywords: z.array(z.object({ text: z.string(), match_type: z.enum(["EXACT","PHRASE","BROAD"]) })), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ email, customer_id, level, level_id, keywords, login_customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const l = lcid(email, login_customer_id);
    if (level === "campaign") {
      const ops = keywords.map(kw => ({ create: { campaign: `customers/${cid}/campaigns/${level_id}`, negative: true, keyword: { text: kw.text, matchType: kw.match_type } } }));
      return { content: [{ type: "text", text: JSON.stringify(await apiPost(email, `customers/${cid}/campaignCriteria:mutate`, { operations: ops }, l), null, 2) }] };
    }
    const ops = keywords.map(kw => ({ create: { adGroup: `customers/${cid}/adGroups/${level_id}`, status: "ENABLED", negative: true, keyword: { text: kw.text, matchType: kw.match_type } } }));
    return { content: [{ type: "text", text: JSON.stringify(await apiPost(email, `customers/${cid}/adGroupCriteria:mutate`, { operations: ops }, l), null, 2) }] };
  });

  server.registerTool("ads_update_keyword", {
    title: "Update Keyword",
    description: "Update keyword status or CPC bid.",
    inputSchema: { email: z.string(), customer_id: z.string(), ad_group_id: z.string(), criterion_id: z.string(), status: z.enum(["ENABLED","PAUSED"]).optional(), cpc_bid_micros: z.number().optional(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, ad_group_id, criterion_id, status, cpc_bid_micros, login_customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const upd: Record<string, unknown> = { resourceName: `customers/${cid}/adGroupCriteria/${ad_group_id}~${criterion_id}` };
    const mask: string[] = [];
    if (status) { upd.status = status; mask.push("status"); }
    if (cpc_bid_micros) { upd.cpcBidMicros = cpc_bid_micros; mask.push("cpc_bid_micros"); }
    const r = await apiPost(email, `customers/${cid}/adGroupCriteria:mutate`, { operations: [{ update: upd, updateMask: mask.join(",") }] }, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── REPORTING ─────────────────────────────────────────────────────────────

  server.registerTool("ads_run_gaql_query", {
    title: "Run GAQL Query",
    description: "Run any custom Google Ads Query Language (GAQL) query. Use for advanced reporting not covered by other tools. Example: SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS",
    inputSchema: { email: z.string(), customer_id: z.string(), query: z.string(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, query, login_customer_id }) => {
    const r = await gaql(email, customer_id, query, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_get_account_performance", {
    title: "Get Account Performance",
    description: "Overall account performance summary: clicks, impressions, cost, conversions, ROAS.",
    inputSchema: { email: z.string(), customer_id: z.string(), date_range: z.enum(["TODAY","YESTERDAY","LAST_7_DAYS","LAST_30_DAYS","THIS_MONTH","LAST_MONTH","LAST_90_DAYS"]).default("LAST_30_DAYS"), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, date_range, login_customer_id }) => {
    const r = await gaql(email, customer_id, `SELECT customer.id, customer.descriptive_name, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.view_through_conversions, metrics.cost_per_conversion, metrics.conversion_rate FROM customer WHERE segments.date DURING ${date_range}`, lcid(email, login_customer_id));
    const x = r[0] as Record<string, Record<string, unknown>> | undefined;
    if (!x) return { content: [{ type: "text", text: "No data" }] };
    return { content: [{ type: "text", text: JSON.stringify({ customer: x.customer?.descriptiveName, date_range, clicks: x.metrics?.clicks, impressions: x.metrics?.impressions, ctr: pct(x.metrics?.ctr), avg_cpc: "$" + m2c(x.metrics?.averageCpc as number || 0), cost: "$" + m2c(x.metrics?.costMicros as number || 0), conversions: x.metrics?.conversions, conv_value: "$" + m2c(x.metrics?.conversionsValue as number || 0), cost_per_conv: "$" + m2c(x.metrics?.costPerConversion as number || 0), conv_rate: pct(x.metrics?.conversionRate) }, null, 2) }] };
  });

  server.registerTool("ads_get_search_terms_report", {
    title: "Get Search Terms Report",
    description: "Show which search queries triggered your ads, with clicks, cost, and conversions.",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string().optional(), date_range: z.enum(["LAST_7_DAYS","LAST_14_DAYS","LAST_30_DAYS","THIS_MONTH"]).default("LAST_30_DAYS"), min_impressions: z.number().default(1), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, date_range, min_impressions, login_customer_id }) => {
    const cf = campaign_id ? `AND campaign.id = ${campaign_id}` : "";
    const r = await gaql(email, customer_id, `SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.id, ad_group.name, metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date DURING ${date_range} AND metrics.impressions >= ${min_impressions} ${cf} ORDER BY metrics.cost_micros DESC`, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_get_geo_performance", {
    title: "Get Geographic Performance",
    description: "Performance breakdown by geographic location (country, region, city).",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string().optional(), date_range: z.enum(["LAST_7_DAYS","LAST_30_DAYS","THIS_MONTH","LAST_MONTH"]).default("LAST_30_DAYS"), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, date_range, login_customer_id }) => {
    const cf = campaign_id ? `AND campaign.id = ${campaign_id}` : "";
    const r = await gaql(email, customer_id, `SELECT geographic_view.location_type, geographic_view.country_criterion_id, campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.ctr, metrics.cost_micros, metrics.conversions FROM geographic_view WHERE segments.date DURING ${date_range} ${cf} ORDER BY metrics.cost_micros DESC`, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_get_device_performance", {
    title: "Get Device Performance",
    description: "Performance breakdown by device (mobile, desktop, tablet).",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string().optional(), date_range: z.enum(["LAST_7_DAYS","LAST_30_DAYS","THIS_MONTH","LAST_MONTH"]).default("LAST_30_DAYS"), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, date_range, login_customer_id }) => {
    const cf = campaign_id ? `AND campaign.id = ${campaign_id}` : "";
    const r = await gaql(email, customer_id, `SELECT segments.device, campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.ctr, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING ${date_range} ${cf} ORDER BY metrics.cost_micros DESC`, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── BUDGETS ───────────────────────────────────────────────────────────────

  server.registerTool("ads_list_budgets", {
    title: "List Campaign Budgets",
    description: "List all campaign budgets with amounts and utilization.",
    inputSchema: { email: z.string(), customer_id: z.string(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, login_customer_id }) => {
    const r = await gaql(email, customer_id, "SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.status, campaign_budget.delivery_method, campaign_budget.total_amount_micros, campaign_budget.period, campaign_budget.reference_count FROM campaign_budget WHERE campaign_budget.status != 'REMOVED'", lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  server.registerTool("ads_update_budget", {
    title: "Update Campaign Budget",
    description: "Change the daily budget amount for a campaign budget.",
    inputSchema: { email: z.string(), customer_id: z.string(), budget_id: z.string(), amount_micros: z.number().describe("New daily budget in micros (1000000 = $1)"), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, budget_id, amount_micros, login_customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const r = await apiPost(email, `customers/${cid}/campaignBudgets:mutate`, { operations: [{ update: { resourceName: `customers/${cid}/campaignBudgets/${budget_id}`, amountMicros: amount_micros }, updateMask: "amount_micros" }] }, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── RECOMMENDATIONS ───────────────────────────────────────────────────────

  server.registerTool("ads_list_recommendations", {
    title: "List Recommendations",
    description: "List Google Ads optimization recommendations for the account.",
    inputSchema: { email: z.string(), customer_id: z.string(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, login_customer_id }) => {
    const r = await gaql(email, customer_id, "SELECT recommendation.type, recommendation.impact.base_metrics.clicks, recommendation.impact.potential_metrics.clicks, campaign.name FROM recommendation", lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── CONVERSIONS ───────────────────────────────────────────────────────────

  server.registerTool("ads_list_conversion_actions", {
    title: "List Conversion Actions",
    description: "List all conversion actions defined in the account.",
    inputSchema: { email: z.string(), customer_id: z.string(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, login_customer_id }) => {
    const r = await gaql(email, customer_id, "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.counting_type, conversion_action.value_settings.default_value, conversion_action.value_settings.always_use_default_value FROM conversion_action WHERE conversion_action.status != 'REMOVED'", lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── AUDIENCE / TARGETING ──────────────────────────────────────────────────

  server.registerTool("ads_list_audience_targeting", {
    title: "List Audience Targeting",
    description: "List audience targeting criteria on campaigns or ad groups.",
    inputSchema: { email: z.string(), customer_id: z.string(), campaign_id: z.string().optional(), login_customer_id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, login_customer_id }) => {
    const cf = campaign_id ? `AND campaign.id = ${campaign_id}` : "";
    const r = await gaql(email, customer_id, `SELECT ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.status, ad_group_criterion.bid_modifier, ad_group.id, ad_group.name, campaign.id, campaign.name FROM ad_group_criterion WHERE ad_group_criterion.type IN ('USER_LIST','USER_INTEREST','LIFE_EVENT','DETAILED_DEMOGRAPHIC','CUSTOM_AFFINITY','CUSTOM_INTENT') AND ad_group_criterion.status != 'REMOVED' ${cf}`, lcid(email, login_customer_id));
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  });

  // ── OAUTH HELPERS ─────────────────────────────────────────────────────────

  server.registerTool("ads_get_oauth_url", {
    title: "Get OAuth Authorization URL",
    description: "Generate the Google OAuth2 URL to authorize a Google Ads account. Visit the URL, sign in with the account's email, approve, and copy the code shown. Then call ads_exchange_code.",
    inputSchema: { redirect_uri: z.string().default("urn:ietf:wg:oauth:2.0:oob") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ redirect_uri }) => {
    const url = `${AUTH_URL}?${new URLSearchParams({ client_id: CLIENT_ID, redirect_uri, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent" }).toString()}`;
    return { content: [{ type: "text", text: `Visit this URL in a browser (signed in with the target account):\n\n${url}\n\nAfter approving, copy the code and call ads_exchange_code with it.` }] };
  });

  server.registerTool("ads_exchange_code", {
    title: "Exchange OAuth Code for Refresh Token",
    description: "Exchange the authorization code from ads_get_oauth_url for a refresh token. Provide the refresh_token and customer_id to me so I can update GOOGLE_ADS_ACCOUNTS in Railway.",
    inputSchema: { code: z.string(), redirect_uri: z.string().default("urn:ietf:wg:oauth:2.0:oob") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ code, redirect_uri }) => {
    const params = new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri });
    const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
    if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
    const data = await res.json() as { access_token: string; refresh_token: string; token_type: string };
    return { content: [{ type: "text", text: JSON.stringify({ message: "Success! Give me the refresh_token + email + customer_id and I will update Railway.", refresh_token: data.refresh_token, access_token_preview: data.access_token.slice(0, 20) + "..." }, null, 2) }] };
  });

  return server;
}

// ── HTTP SERVER (dual transport: SSE legacy + Streamable HTTP) ─────────────────

const PORT = parseInt(process.env.PORT || "3000");
const BASE = process.env.SERVER_URL || `http://localhost:${PORT}`;

// Legacy SSE sessions: sessionId -> SSEServerTransport
const sseSessions: Record<string, SSEServerTransport> = {};
// Streamable HTTP sessions: sessionId -> StreamableHTTPServerTransport
const httpSessions: Record<string, StreamableHTTPServerTransport> = {};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "google-ads-mcp-server", version: "1.0.0", accounts: Object.keys(getAccounts()).length }));
    return;
  }

  // ── STREAMABLE HTTP transport (modern, Claude.ai uses this) ──────────────────
  // Claude.ai POSTs JSON-RPC to /mcp or /sse with Accept: application/json, text/event-stream
  if ((url.pathname === "/mcp" || url.pathname === "/sse") && (req.method === "POST" || req.method === "DELETE")) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport | undefined = sessionId ? httpSessions[sessionId] : undefined;

    if (req.method === "POST") {
      const raw = await readBody(req);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { res.writeHead(400); res.end("Invalid JSON"); return; }

      const isInit = Array.isArray(parsed)
        ? parsed.some((m: { method?: string }) => m?.method === "initialize")
        : (parsed as { method?: string })?.method === "initialize";

      if (!transport && isInit) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => { httpSessions[sid] = transport!; },
        });
        transport.onclose = () => { if (transport!.sessionId) delete httpSessions[transport!.sessionId]; };
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }

      if (!transport) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session. Send initialize first." }, id: null }));
        return;
      }
      await transport.handleRequest(req, res, parsed);
      return;
    }

    // DELETE - close session
    if (req.method === "DELETE") {
      if (transport) { await transport.handleRequest(req, res); }
      else { res.writeHead(404); res.end("No session"); }
      return;
    }
  }

  // ── STREAMABLE HTTP: GET on /mcp opens an SSE stream for server->client ───────
  if (req.method === "GET" && url.pathname === "/mcp") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? httpSessions[sessionId] : undefined;
    if (!transport) { res.writeHead(400); res.end("No session"); return; }
    await transport.handleRequest(req, res);
    return;
  }

  // ── LEGACY SSE transport (GET /sse opens stream) ─────────────────────────────
  if (req.method === "GET" && url.pathname === "/sse") {
    const mcpServer = createMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    sseSessions[transport.sessionId] = transport;
    res.on("close", () => { delete sseSessions[transport.sessionId]; });
    await mcpServer.connect(transport);
    return;
  }

  // Legacy SSE messages (client -> server)
  if (req.method === "POST" && url.pathname === "/messages") {
    const sessionId = (url.searchParams.get("sessionId") || req.headers["mcp-session-id"]) as string;
    const transport = sseSessions[sessionId];
    if (!transport) { res.writeHead(404); res.end("Session not found"); return; }
    const raw = await readBody(req);
    try { await transport.handlePostMessage(req, res, JSON.parse(raw)); }
    catch (e) { res.writeHead(500); res.end(String(e)); }
    return;
  }

  // No OAuth: this server is unauthenticated. Returning 404 on /.well-known/*
  // signals to MCP clients (Claude.ai) to connect WITHOUT an auth flow.

  res.writeHead(404);
  res.end("Not found");
});
server.listen(PORT, () => console.error(`Google Ads MCP Server (dual transport) on port ${PORT}`));
