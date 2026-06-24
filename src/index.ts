import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "http";

const API_VERSION = "v20";
const BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;
const TOKEN_URL = "https://www.googleapis.com/oauth2/v3/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/adwords";

const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || "";

// Per-account refresh tokens stored as JSON env var:
// GOOGLE_ADS_ACCOUNTS={"email1@x.com":{"refresh_token":"rt1","customer_id":"1234567890"},...}
function getAccounts(): Record<string, { refresh_token: string; customer_id: string; login_customer_id?: string }> {
  try {
    const raw = process.env.GOOGLE_ADS_ACCOUNTS || "{}";
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Token cache: email -> { access_token, expires_at }
const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

async function getAccessToken(email: string): Promise<string> {
  const cached = tokenCache[email];
  if (cached && Date.now() < cached.expires_at - 60000) {
    return cached.access_token;
  }

  const accounts = getAccounts();
  const account = accounts[email];
  if (!account) {
    throw new Error(`No account found for email: ${email}. Use ads_list_accounts to see configured accounts.`);
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: account.refresh_token,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token refresh failed for ${email}: ${err}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  tokenCache[email] = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

function buildHeaders(accessToken: string, loginCustomerId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "developer-token": DEVELOPER_TOKEN,
    "Authorization": `Bearer ${accessToken}`,
  };
  if (loginCustomerId) {
    headers["login-customer-id"] = loginCustomerId.replace(/-/g, "");
  }
  return headers;
}

async function gaqlSearch(email: string, customerId: string, query: string, loginCustomerId?: string): Promise<unknown[]> {
  const accessToken = await getAccessToken(email);
  const cid = customerId.replace(/-/g, "");
  const headers = buildHeaders(accessToken, loginCustomerId);

  const response = await fetch(`${BASE_URL}/customers/${cid}/googleAds:search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`GAQL search failed: ${response.status} ${err}`);
  }

  const data = await response.json() as { results?: unknown[]; nextPageToken?: string };
  return data.results || [];
}

async function apiGet(email: string, path: string, loginCustomerId?: string): Promise<unknown> {
  const accessToken = await getAccessToken(email);
  const headers = buildHeaders(accessToken, loginCustomerId);

  const response = await fetch(`${BASE_URL}/${path}`, { method: "GET", headers });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API GET failed: ${response.status} ${err}`);
  }
  return response.json();
}

async function apiPost(email: string, path: string, body: unknown, loginCustomerId?: string): Promise<unknown> {
  const accessToken = await getAccessToken(email);
  const headers = buildHeaders(accessToken, loginCustomerId);

  const response = await fetch(`${BASE_URL}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API POST failed: ${response.status} ${err}`);
  }
  return response.json();
}

function microsToCurrency(micros: number | string): string {
  return (Number(micros) / 1_000_000).toFixed(2);
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "google-ads-mcp-server",
    version: "1.0.0",
  });

  // ─── ACCOUNT MANAGEMENT ───────────────────────────────────────────────────

  server.registerTool("ads_list_accounts", {
    title: "List Configured Accounts",
    description: "List all Google Ads accounts configured in this server (by email). Use this first to see which accounts/emails are available.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const accounts = getAccounts();
    const entries = Object.entries(accounts).map(([email, info]) => ({
      email,
      customer_id: info.customer_id,
      login_customer_id: info.login_customer_id || null,
    }));
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No accounts configured. Set GOOGLE_ADS_ACCOUNTS env var." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
  });

  server.registerTool("ads_list_accessible_customers", {
    title: "List Accessible Customers",
    description: "List all Google Ads customer accounts accessible via the authenticated user's OAuth credentials.",
    inputSchema: {
      email: z.string().describe("Email of the account to authenticate with"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email }) => {
    const data = await apiGet(email, "customers:listAccessibleCustomers") as { resourceNames?: string[] };
    return { content: [{ type: "text", text: JSON.stringify(data.resourceNames || [], null, 2) }] };
  });

  server.registerTool("ads_get_customer_info", {
    title: "Get Customer Info",
    description: "Retrieve basic info about a Google Ads customer account (name, currency, timezone, status).",
    inputSchema: {
      email: z.string().describe("Email of the account to authenticate with"),
      customer_id: z.string().describe("The 10-digit customer ID (with or without dashes)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id }) => {
    const cid = customer_id.replace(/-/g, "");
    const results = await gaqlSearch(email, cid,
      "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager FROM customer LIMIT 1"
    );
    return { content: [{ type: "text", text: JSON.stringify(results[0] || {}, null, 2) }] };
  });

  // ─── CAMPAIGNS ────────────────────────────────────────────────────────────

  server.registerTool("ads_list_campaigns", {
    title: "List Campaigns",
    description: "List all campaigns in a Google Ads account with status, budget, and basic metrics.",
    inputSchema: {
      email: z.string().describe("Email of the account to authenticate with"),
      customer_id: z.string().describe("The 10-digit customer ID"),
      date_range: z.enum(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH", "ALL_TIME"]).default("LAST_30_DAYS").describe("Date range for metrics"),
      status_filter: z.enum(["ALL", "ENABLED", "PAUSED", "REMOVED"]).default("ALL").describe("Filter by campaign status"),
      login_customer_id: z.string().optional().describe("Manager account ID if accessing via MCC"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, date_range, status_filter, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const statusClause = status_filter !== "ALL" ? `AND campaign.status = '${status_filter}'` : "AND campaign.status != 'REMOVED'";
    const dateClause = date_range === "ALL_TIME" ? "" : `AND segments.date DURING ${date_range}`;

    const results = await gaqlSearch(email, customer_id,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
       campaign_budget.amount_micros, metrics.clicks, metrics.impressions, metrics.ctr,
       metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value,
       campaign.bidding_strategy_type, campaign.optimization_score
       FROM campaign WHERE 1=1 ${statusClause} ${dateClause}
       ORDER BY metrics.cost_micros DESC`,
      lcid
    );

    const formatted = results.map((r: unknown) => {
      const row = r as Record<string, Record<string, unknown>>;
      return {
        id: row.campaign?.id,
        name: row.campaign?.name,
        status: row.campaign?.status,
        type: row.campaign?.advertisingChannelType,
        budget: microsToCurrency(row.campaignBudget?.amountMicros as number || 0),
        clicks: row.metrics?.clicks,
        impressions: row.metrics?.impressions,
        ctr: ((Number(row.metrics?.ctr) || 0) * 100).toFixed(2) + "%",
        avg_cpc: microsToCurrency(row.metrics?.averageCpc as number || 0),
        cost: microsToCurrency(row.metrics?.costMicros as number || 0),
        conversions: row.metrics?.conversions,
        conv_value: microsToCurrency(row.metrics?.conversionsValue as number || 0),
        optimization_score: row.campaign?.optimizationScore,
      };
    });

    return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
  });

  server.registerTool("ads_get_campaign_performance", {
    title: "Get Campaign Performance",
    description: "Get detailed performance metrics for a specific campaign with breakdown by day, device, or network.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      campaign_id: z.string().describe("The campaign ID"),
      date_range: z.enum(["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"]).default("LAST_30_DAYS"),
      segment_by: z.enum(["none", "day", "device", "network"]).default("none").describe("Segment results by dimension"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, date_range, segment_by, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    let segmentSelect = "";
    let segmentFrom = "";
    if (segment_by === "day") { segmentSelect = ", segments.date"; }
    else if (segment_by === "device") { segmentSelect = ", segments.device"; }
    else if (segment_by === "network") { segmentSelect = ", segments.ad_network_type"; }

    const results = await gaqlSearch(email, customer_id,
      `SELECT campaign.id, campaign.name, metrics.clicks, metrics.impressions, metrics.ctr,
       metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value,
       metrics.search_impression_share, metrics.search_budget_lost_impression_share,
       metrics.search_rank_lost_impression_share, metrics.all_conversions,
       metrics.view_through_conversions${segmentSelect}
       FROM campaign${segmentFrom}
       WHERE campaign.id = ${campaign_id} AND segments.date DURING ${date_range}`,
      lcid
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool("ads_create_campaign", {
    title: "Create Campaign",
    description: "Create a new Google Ads campaign with a budget.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      name: z.string().describe("Campaign name"),
      campaign_type: z.enum(["SEARCH", "DISPLAY", "SHOPPING", "VIDEO", "PERFORMANCE_MAX"]).default("SEARCH"),
      daily_budget_micros: z.number().describe("Daily budget in micros (e.g. 10000000 = $10)"),
      bidding_strategy: z.enum(["MANUAL_CPC", "TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_IMPRESSION_SHARE"]).default("MAXIMIZE_CONVERSIONS"),
      status: z.enum(["ENABLED", "PAUSED"]).default("PAUSED"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ email, customer_id, name, campaign_type, daily_budget_micros, bidding_strategy, status, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const cid = customer_id.replace(/-/g, "");

    // Create budget first
    const budgetResp = await apiPost(email, `customers/${cid}/campaignBudgets:mutate`, {
      operations: [{
        create: {
          name: `Budget for ${name}`,
          amountMicros: daily_budget_micros,
          deliveryMethod: "STANDARD",
        }
      }]
    }, lcid) as { results?: Array<{ resourceName: string }> };

    const budgetResourceName = budgetResp.results?.[0]?.resourceName;
    if (!budgetResourceName) throw new Error("Failed to create campaign budget");

    const biddingConfig: Record<string, unknown> = {};
    if (bidding_strategy === "MANUAL_CPC") biddingConfig.manualCpc = { enhancedCpcEnabled: true };
    else if (bidding_strategy === "MAXIMIZE_CONVERSIONS") biddingConfig.maximizeConversions = {};
    else if (bidding_strategy === "MAXIMIZE_CONVERSION_VALUE") biddingConfig.maximizeConversionValue = {};
    else if (bidding_strategy === "TARGET_CPA") biddingConfig.targetCpa = {};
    else if (bidding_strategy === "TARGET_ROAS") biddingConfig.targetRoas = {};

    const campaignResp = await apiPost(email, `customers/${cid}/campaigns:mutate`, {
      operations: [{
        create: {
          name,
          status,
          advertisingChannelType: campaign_type,
          campaignBudget: budgetResourceName,
          ...biddingConfig,
        }
      }]
    }, lcid);

    return { content: [{ type: "text", text: JSON.stringify(campaignResp, null, 2) }] };
  });

  server.registerTool("ads_update_campaign", {
    title: "Update Campaign",
    description: "Update a campaign status, name, or budget.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      campaign_id: z.string(),
      status: z.enum(["ENABLED", "PAUSED"]).optional(),
      name: z.string().optional(),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, status, name, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const cid = customer_id.replace(/-/g, "");
    const resourceName = `customers/${cid}/campaigns/${campaign_id}`;

    const updateFields: Record<string, unknown> = { resourceName };
    const updateMask: string[] = [];
    if (status) { updateFields.status = status; updateMask.push("status"); }
    if (name) { updateFields.name = name; updateMask.push("name"); }

    const result = await apiPost(email, `customers/${cid}/campaigns:mutate`, {
      operations: [{ update: updateFields, updateMask: updateMask.join(",") }]
    }, lcid);

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // ─── AD GROUPS ────────────────────────────────────────────────────────────

  server.registerTool("ads_list_ad_groups", {
    title: "List Ad Groups",
    description: "List all ad groups in a campaign with performance metrics.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      campaign_id: z.string().optional().describe("Filter by campaign ID (optional)"),
      date_range: z.enum(["LAST_7_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"]).default("LAST_30_DAYS"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, date_range, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const campaignFilter = campaign_id ? `AND campaign.id = ${campaign_id}` : "";

    const results = await gaqlSearch(email, customer_id,
      `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
       campaign.id, campaign.name,
       metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions
       FROM ad_group
       WHERE ad_group.status != 'REMOVED' ${campaignFilter}
       AND segments.date DURING ${date_range}
       ORDER BY metrics.cost_micros DESC`,
      lcid
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool("ads_update_ad_group", {
    title: "Update Ad Group",
    description: "Update an ad group status, name, or CPC bid.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      ad_group_id: z.string(),
      status: z.enum(["ENABLED", "PAUSED"]).optional(),
      name: z.string().optional(),
      cpc_bid_micros: z.number().optional().describe("Manual CPC bid in micros"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, ad_group_id, status, name, cpc_bid_micros, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const cid = customer_id.replace(/-/g, "");
    const resourceName = `customers/${cid}/adGroups/${ad_group_id}`;

    const updateFields: Record<string, unknown> = { resourceName };
    const updateMask: string[] = [];
    if (status) { updateFields.status = status; updateMask.push("status"); }
    if (name) { updateFields.name = name; updateMask.push("name"); }
    if (cpc_bid_micros) { updateFields.cpcBidMicros = cpc_bid_micros; updateMask.push("cpc_bid_micros"); }

    const result = await apiPost(email, `customers/${cid}/adGroups:mutate`, {
      operations: [{ update: updateFields, updateMask: updateMask.join(",") }]
    }, lcid);

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // ─── ADS ──────────────────────────────────────────────────────────────────

  server.registerTool("ads_list_ads", {
    title: "List Ads",
    description: "List ads with performance metrics. Filter by campaign or ad group.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      campaign_id: z.string().optional(),
      ad_group_id: z.string().optional(),
      date_range: z.enum(["LAST_7_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"]).default("LAST_30_DAYS"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, ad_group_id, date_range, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const filters: string[] = ["ad_group_ad.status != 'REMOVED'"];
    if (campaign_id) filters.push(`campaign.id = ${campaign_id}`);
    if (ad_group_id) filters.push(`ad_group.id = ${ad_group_id}`);

    const results = await gaqlSearch(email, customer_id,
      `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status,
       ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
       ad_group_ad.ad.responsive_search_ad.headlines,
       ad_group_ad.ad.responsive_search_ad.descriptions,
       ad_group.id, ad_group.name, campaign.id, campaign.name,
       metrics.clicks, metrics.impressions, metrics.ctr,
       metrics.average_cpc, metrics.cost_micros, metrics.conversions
       FROM ad_group_ad
       WHERE ${filters.join(" AND ")}
       AND segments.date DURING ${date_range}
       ORDER BY metrics.cost_micros DESC`,
      lcid
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  // ─── KEYWORDS ─────────────────────────────────────────────────────────────

  server.registerTool("ads_list_keywords", {
    title: "List Keywords",
    description: "List keywords in an ad group or campaign with bids and performance metrics.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      campaign_id: z.string().optional(),
      ad_group_id: z.string().optional(),
      date_range: z.enum(["LAST_7_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"]).default("LAST_30_DAYS"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, ad_group_id, date_range, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const filters: string[] = ["ad_group_criterion.status != 'REMOVED'", "ad_group_criterion.type = 'KEYWORD'"];
    if (campaign_id) filters.push(`campaign.id = ${campaign_id}`);
    if (ad_group_id) filters.push(`ad_group.id = ${ad_group_id}`);

    const results = await gaqlSearch(email, customer_id,
      `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
       ad_group_criterion.keyword.match_type, ad_group_criterion.status,
       ad_group_criterion.cpc_bid_micros, ad_group_criterion.quality_info.quality_score,
       ad_group.id, ad_group.name, campaign.id, campaign.name,
       metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc,
       metrics.cost_micros, metrics.conversions, metrics.search_impression_share
       FROM ad_group_criterion
       WHERE ${filters.join(" AND ")}
       AND segments.date DURING ${date_range}
       ORDER BY metrics.cost_micros DESC`,
      lcid
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool("ads_add_keywords", {
    title: "Add Keywords",
    description: "Add keywords to an ad group.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      ad_group_id: z.string(),
      keywords: z.array(z.object({
        text: z.string().describe("Keyword text"),
        match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).describe("Match type"),
        cpc_bid_micros: z.number().optional().describe("Bid in micros"),
      })),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ email, customer_id, ad_group_id, keywords, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const cid = customer_id.replace(/-/g, "");
    const adGroupResourceName = `customers/${cid}/adGroups/${ad_group_id}`;

    const operations = keywords.map(kw => ({
      create: {
        adGroup: adGroupResourceName,
        status: "ENABLED",
        keyword: { text: kw.text, matchType: kw.match_type },
        ...(kw.cpc_bid_micros ? { cpcBidMicros: kw.cpc_bid_micros } : {}),
      }
    }));

    const result = await apiPost(email, `customers/${cid}/adGroupCriteria:mutate`, { operations }, lcid);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("ads_add_negative_keywords", {
    title: "Add Negative Keywords",
    description: "Add negative keywords at campaign or ad group level.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      level: z.enum(["campaign", "ad_group"]).describe("Level to add negatives at"),
      level_id: z.string().describe("Campaign ID or Ad Group ID"),
      keywords: z.array(z.object({
        text: z.string(),
        match_type: z.enum(["EXACT", "PHRASE", "BROAD"]),
      })),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ email, customer_id, level, level_id, keywords, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const cid = customer_id.replace(/-/g, "");

    if (level === "campaign") {
      const resourceName = `customers/${cid}/campaigns/${level_id}`;
      const operations = keywords.map(kw => ({
        create: {
          campaign: resourceName,
          negative: true,
          keyword: { text: kw.text, matchType: kw.match_type },
        }
      }));
      const result = await apiPost(email, `customers/${cid}/campaignCriteria:mutate`, { operations }, lcid);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } else {
      const resourceName = `customers/${cid}/adGroups/${level_id}`;
      const operations = keywords.map(kw => ({
        create: {
          adGroup: resourceName,
          status: "ENABLED",
          negative: true,
          keyword: { text: kw.text, matchType: kw.match_type },
        }
      }));
      const result = await apiPost(email, `customers/${cid}/adGroupCriteria:mutate`, { operations }, lcid);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  });

  // ─── REPORTING ────────────────────────────────────────────────────────────

  server.registerTool("ads_run_gaql_query", {
    title: "Run GAQL Query",
    description: "Run a custom Google Ads Query Language (GAQL) query for any reporting or data retrieval. Use this for advanced reporting not covered by other tools.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      query: z.string().describe("GAQL query string. Example: SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, query, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const results = await gaqlSearch(email, customer_id, query, lcid);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool("ads_get_search_terms_report", {
    title: "Get Search Terms Report",
    description: "Get the search terms report showing what queries triggered your ads.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      campaign_id: z.string().optional(),
      date_range: z.enum(["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH"]).default("LAST_30_DAYS"),
      min_impressions: z.number().default(1).describe("Minimum impressions threshold"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, campaign_id, date_range, min_impressions, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const campaignFilter = campaign_id ? `AND campaign.id = ${campaign_id}` : "";

    const results = await gaqlSearch(email, customer_id,
      `SELECT search_term_view.search_term, search_term_view.status,
       campaign.id, campaign.name, ad_group.id, ad_group.name,
       metrics.clicks, metrics.impressions, metrics.ctr,
       metrics.average_cpc, metrics.cost_micros, metrics.conversions
       FROM search_term_view
       WHERE segments.date DURING ${date_range}
       AND metrics.impressions >= ${min_impressions}
       ${campaignFilter}
       ORDER BY metrics.cost_micros DESC`,
      lcid
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool("ads_get_account_performance", {
    title: "Get Account Performance",
    description: "Get overall account performance summary with key metrics.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      date_range: z.enum(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"]).default("LAST_30_DAYS"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, date_range, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;

    const results = await gaqlSearch(email, customer_id,
      `SELECT customer.id, customer.descriptive_name,
       metrics.clicks, metrics.impressions, metrics.ctr, metrics.average_cpc,
       metrics.cost_micros, metrics.conversions, metrics.conversions_value,
       metrics.all_conversions, metrics.view_through_conversions,
       metrics.cost_per_conversion, metrics.conversion_rate
       FROM customer
       WHERE segments.date DURING ${date_range}`,
      lcid
    );

    const r = results[0] as Record<string, Record<string, unknown>> | undefined;
    if (!r) return { content: [{ type: "text", text: "No data found" }] };

    const summary = {
      customer: r.customer?.descriptiveName,
      date_range,
      clicks: r.metrics?.clicks,
      impressions: r.metrics?.impressions,
      ctr: ((Number(r.metrics?.ctr) || 0) * 100).toFixed(2) + "%",
      avg_cpc: "$" + microsToCurrency(r.metrics?.averageCpc as number || 0),
      total_cost: "$" + microsToCurrency(r.metrics?.costMicros as number || 0),
      conversions: r.metrics?.conversions,
      conv_value: "$" + microsToCurrency(r.metrics?.conversionsValue as number || 0),
      cost_per_conv: "$" + microsToCurrency(r.metrics?.costPerConversion as number || 0),
      conv_rate: ((Number(r.metrics?.conversionRate) || 0) * 100).toFixed(2) + "%",
    };

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  });

  // ─── RECOMMENDATIONS ──────────────────────────────────────────────────────

  server.registerTool("ads_list_recommendations", {
    title: "List Recommendations",
    description: "List optimization recommendations from Google Ads for a customer account.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;

    const results = await gaqlSearch(email, customer_id,
      `SELECT recommendation.type, recommendation.impact.base_metrics.clicks,
       recommendation.impact.potential_metrics.clicks,
       campaign.name
       FROM recommendation`,
      lcid
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  // ─── BUDGETS ──────────────────────────────────────────────────────────────

  server.registerTool("ads_list_budgets", {
    title: "List Campaign Budgets",
    description: "List all campaign budgets in the account.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;

    const results = await gaqlSearch(email, customer_id,
      `SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros,
       campaign_budget.status, campaign_budget.delivery_method,
       campaign_budget.total_amount_micros, campaign_budget.period,
       campaign_budget.reference_count
       FROM campaign_budget
       WHERE campaign_budget.status != 'REMOVED'`,
      lcid
    );

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.registerTool("ads_update_budget", {
    title: "Update Campaign Budget",
    description: "Update the amount of a campaign budget.",
    inputSchema: {
      email: z.string(),
      customer_id: z.string(),
      budget_id: z.string(),
      amount_micros: z.number().describe("New daily budget amount in micros (1000000 = $1)"),
      login_customer_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, customer_id, budget_id, amount_micros, login_customer_id }) => {
    const accounts = getAccounts();
    const lcid = login_customer_id || accounts[email]?.login_customer_id;
    const cid = customer_id.replace(/-/g, "");
    const resourceName = `customers/${cid}/campaignBudgets/${budget_id}`;

    const result = await apiPost(email, `customers/${cid}/campaignBudgets:mutate`, {
      operations: [{
        update: { resourceName, amountMicros: amount_micros },
        updateMask: "amount_micros",
      }]
    }, lcid);

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  // ─── OAUTH HELPER ─────────────────────────────────────────────────────────

  server.registerTool("ads_get_oauth_url", {
    title: "Get OAuth Authorization URL",
    description: "Generate the OAuth2 authorization URL to get consent for a new Google Ads account. After the user visits this URL and authorizes, they get a code to exchange for tokens.",
    inputSchema: {
      redirect_uri: z.string().default("urn:ietf:wg:oauth:2.0:oob").describe("Redirect URI (use urn:ietf:wg:oauth:2.0:oob for manual code copy)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ redirect_uri }) => {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    });
    const url = `${AUTH_URL}?${params.toString()}`;
    return { content: [{ type: "text", text: `Visit this URL to authorize:\n${url}\n\nAfter authorization, you'll get a code. Use ads_exchange_code to get the refresh token.` }] };
  });

  server.registerTool("ads_exchange_code", {
    title: "Exchange Authorization Code for Tokens",
    description: "Exchange an OAuth2 authorization code for access and refresh tokens. After getting the refresh token, add it to the GOOGLE_ADS_ACCOUNTS env var.",
    inputSchema: {
      code: z.string().describe("The authorization code from the OAuth consent screen"),
      redirect_uri: z.string().default("urn:ietf:wg:oauth:2.0:oob"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ code, redirect_uri }) => {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri,
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await response.json() as { access_token: string; refresh_token: string; token_type: string };
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          message: "Success! Add the refresh_token to GOOGLE_ADS_ACCOUNTS env var.",
          refresh_token: data.refresh_token,
          access_token: data.access_token,
          token_type: data.token_type,
          format_example: '{"email@example.com":{"refresh_token":"1//...", "customer_id":"1234567890"}}',
        }, null, 2)
      }]
    };
  });

  return server;
}

// ─── SSE SERVER ───────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000");

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "google-ads-mcp-server", version: "1.0.0" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sse") {
    const server = createMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
    return;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ resource: `http://localhost:${PORT}`, authorization_servers: [`http://localhost:${PORT}`] }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    const base = process.env.SERVER_URL || `http://localhost:${PORT}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    }));
    return;
  }

  if (url.pathname === "/register") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ client_id: "google-ads-mcp", client_secret: "mcp-secret", redirect_uris: [] }));
    return;
  }

  if (url.pathname === "/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const state = url.searchParams.get("state") || "";
    const redirectUrl = `${redirectUri}?code=auto_approved&state=${state}`;
    res.writeHead(302, { Location: redirectUrl });
    res.end();
    return;
  }

  if (url.pathname === "/token") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: "mcp-token", token_type: "bearer", expires_in: 86400 }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.error(`Google Ads MCP Server running on port ${PORT}`);
});
