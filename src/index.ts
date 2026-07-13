import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import http from "http";
import { JWT } from "google-auth-library";

const API_VERSION = "v21";
const BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;
const SCOPE = "https://www.googleapis.com/auth/adwords";
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";

// Service Account credentials (never expire)
let jwtClient: JWT | null = null;

async function initServiceAccountAuth(): Promise<JWT> {
  if (jwtClient) return jwtClient;
  
  const serviceAccountJson = process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("GOOGLE_ADS_SERVICE_ACCOUNT_JSON environment variable not set");
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    jwtClient = new JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: [SCOPE],
    });
    return jwtClient;
  } catch (error) {
    throw new Error(`Failed to initialize Service Account: ${error}`);
  }
}

async function getAccessToken(): Promise<string> {
  const client = await initServiceAccountAuth();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error("Failed to get access token from Service Account");
  }
  return token.token;
}

async function makeGoogleAdsRequest(
  method: string,
  endpoint: string,
  body?: object
): Promise<any> {
  const accessToken = await getAccessToken();
  const url = `${BASE_URL}${endpoint}`;

  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "developer-token": DEVELOPER_TOKEN,
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// MCP Server setup
const server = new McpServer({
  name: "google-ads-mcp",
  version: "1.0.0",
});

// Get accessible customers
server.tool(
  "list_accessible_customers",
  "Get all accessible Google Ads customer IDs",
  {},
  async () => {
    const result = await makeGoogleAdsRequest(
      "GET",
      "/customers:listAccessibleCustomers"
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// List campaigns
server.tool(
  "list_campaigns",
  "List campaigns for a customer",
  {
    customerId: z.string().describe("Google Ads customer ID"),
  },
  async ({ customerId }) => {
    const query = `
      SELECT campaign.id, campaign.name, campaign.status
      FROM campaign
      ORDER BY campaign.id
    `;
    
    const result = await makeGoogleAdsRequest("POST", `/customers/${customerId}/googleAds:search`, {
      query,
    });
    
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Get account performance
server.tool(
  "get_account_performance",
  "Get account performance metrics",
  {
    customerId: z.string().describe("Google Ads customer ID"),
  },
  async ({ customerId }) => {
    const query = `
      SELECT metrics.impressions, metrics.clicks, metrics.cost_micros
      FROM customer
    `;
    
    const result = await makeGoogleAdsRequest("POST", `/customers/${customerId}/googleAds:search`, {
      query,
    });
    
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Health check
server.tool(
  "health_check",
  "Check if Service Account authentication is working",
  {},
  async () => {
    try {
      const token = await getAccessToken();
      return {
        content: [
          {
            type: "text",
            text: `✅ Service Account authenticated successfully\nToken: ${token.substring(0, 20)}...`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Authentication failed: ${error}`,
          },
        ],
      };
    }
  }
);

// Server startup
const transport = new SSEServerTransport("/messages", http.createServer());

http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }
  
  if (req.url?.startsWith("/messages")) {
    return transport.handleRequest(req, res);
  }
  
  res.writeHead(404);
  res.end("Not Found");
}).listen(process.env.PORT || 3000, () => {
  console.log("Google Ads MCP Server started on port", process.env.PORT || 3000);
  console.log("✅ Using Service Account authentication (permanent, never expires)");
  console.log("❌ OAuth refresh tokens removed");
});

server.setRequestHandler(transport);
