// ============================================================
//  GA4-REPORT.JS — Consulta datos en vivo de Google Analytics 4
//  (Google Analytics Data API v1) para el dashboard del panel admin.
//
//  Requiere estas variables de entorno en Netlify:
//    GA4_PROPERTY_ID              (ID numérico de la propiedad GA4)
//    GA4_SERVICE_ACCOUNT_EMAIL    (del JSON de la cuenta de servicio)
//    GA4_SERVICE_ACCOUNT_PRIVATE_KEY  (del mismo JSON)
//
//  Protegido con la misma contraseña de admin que referral.js.
//  Sin dependencias npm — firma el JWT con el módulo crypto nativo.
// ============================================================

const crypto = require("crypto");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const SA_EMAIL = process.env.GA4_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = (process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const FUNNEL_EVENTS = ["view_item", "add_to_cart", "begin_checkout", "purchase"];

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Genera un access_token OAuth2 firmando un JWT con la cuenta de servicio ──
async function getAccessToken() {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: SA_EMAIL,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const unsigned = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claims));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(SA_KEY).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = unsigned + "." + signature;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error("OAuth error: " + JSON.stringify(data));
  return data.access_token;
}

// ── Ejecuta un runReport contra la GA4 Data API ──
async function runReport(accessToken, body) {
  const resp = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error("GA4 API error: " + JSON.stringify(data));
  return data;
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  // ── Auth: misma contraseña que el resto del panel admin ──
  const authHeader = event.headers?.authorization || "";
  const providedPw = authHeader.replace("Bearer ", "").trim();
  if (!ADMIN_PASSWORD || providedPw !== ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "No autorizado" }) };
  }

  if (!PROPERTY_ID || !SA_EMAIL || !SA_KEY) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        configured: false,
        reason: "Faltan variables de entorno: GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_EMAIL o GA4_SERVICE_ACCOUNT_PRIVATE_KEY",
      }),
    };
  }

  const days = parseInt(event.queryStringParameters?.days || "30", 10);
  const dateRange = [{ startDate: `${days}daysAgo`, endDate: "today" }];

  try {
    const accessToken = await getAccessToken();

    // ── 1. Resumen: sesiones, usuarios, ingresos ──
    const overview = await runReport(accessToken, {
      dateRanges: dateRange,
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "purchaseRevenue" },
      ],
    });
    const ov = overview.rows?.[0]?.metricValues || [];

    // ── 2. Embudo: conteo de cada evento clave ──
    const funnel = await runReport(accessToken, {
      dateRanges: dateRange,
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: {
        filter: {
          fieldName: "eventName",
          inListFilter: { values: FUNNEL_EVENTS },
        },
      },
    });
    const funnelCounts = {};
    FUNNEL_EVENTS.forEach((e) => (funnelCounts[e] = 0));
    (funnel.rows || []).forEach((row) => {
      const name = row.dimensionValues[0].value;
      const count = parseInt(row.metricValues[0].value, 10);
      funnelCounts[name] = count;
    });

    // ── 3. Campañas: sesiones por utm_source / utm_campaign ──
    const campaigns = await runReport(accessToken, {
      dateRanges: dateRange,
      dimensions: [{ name: "sessionSource" }, { name: "sessionCampaignName" }],
      metrics: [{ name: "sessions" }, { name: "conversions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 10,
    });
    const campaignRows = (campaigns.rows || []).map((row) => ({
      source: row.dimensionValues[0].value,
      campaign: row.dimensionValues[1].value,
      sessions: parseInt(row.metricValues[0].value, 10),
      conversions: parseFloat(row.metricValues[1].value),
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        configured: true,
        days,
        sessions: parseInt(ov[0]?.value || "0", 10),
        totalUsers: parseInt(ov[1]?.value || "0", 10),
        revenue: parseFloat(ov[2]?.value || "0"),
        funnel: funnelCounts,
        campaigns: campaignRows,
      }),
    };
  } catch (err) {
    console.error("[ga4-report]", err.message);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: false, configured: true, error: err.message }),
    };
  }
};
