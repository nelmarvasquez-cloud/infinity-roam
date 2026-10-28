// ============================================================
//  META-ADS-CLIENT.JS — Cliente de la Meta Marketing API
//  Consulta gasto/impresiones/clics de tus anuncios para combinar
//  con las compras/ingresos ya calculados desde GA4 (CAC/ROAS).
//
//  Variables de entorno requeridas:
//    META_AD_ACCOUNT_ID       (formato: act_XXXXXXXXXXXXX)
//    META_MARKETING_API_TOKEN (token con permiso ads_read)
//
//  Si no están configuradas, se degrada de forma segura — el
//  dashboard simplemente muestra "Meta Ads no conectado".
// ============================================================

const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID;
const ACCESS_TOKEN = process.env.META_MARKETING_API_TOKEN;
const REQUEST_TIMEOUT_MS = 10000;

function isConfigured() {
  return !!(AD_ACCOUNT_ID && ACCESS_TOKEN);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Convierte fechas relativas ("7daysAgo","today") a YYYY-MM-DD ──
function toISODate(relative) {
  const now = new Date();
  if (relative === "today") return now.toISOString().slice(0, 10);
  if (relative === "yesterday") {
    now.setDate(now.getDate() - 1);
    return now.toISOString().slice(0, 10);
  }
  const match = relative.match(/^(\d+)daysAgo$/);
  if (match) {
    now.setDate(now.getDate() - parseInt(match[1], 10));
    return now.toISOString().slice(0, 10);
  }
  return relative; // ya viene como YYYY-MM-DD (rango custom)
}

// ── Insights generales de la cuenta (gasto, impresiones, clics, etc.) ──
async function getAccountInsights(startDate, endDate) {
  if (!isConfigured()) throw new Error("NOT_CONFIGURED");

  const since = toISODate(startDate);
  const until = toISODate(endDate);
  const fields = "spend,impressions,reach,clicks,ctr,cpc,cpm";
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

  const url = `https://graph.facebook.com/v20.0/${AD_ACCOUNT_ID}/insights?fields=${fields}&time_range=${timeRange}&access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
  const resp = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Meta Marketing API error (${resp.status}): ${JSON.stringify(data.error || data)}`);
  }

  const row = (data.data && data.data[0]) || {};
  return {
    spend: parseFloat(row.spend) || 0,
    impressions: parseInt(row.impressions, 10) || 0,
    reach: parseInt(row.reach, 10) || 0,
    clicks: parseInt(row.clicks, 10) || 0,
    ctr: parseFloat(row.ctr) || 0,
    cpc: parseFloat(row.cpc) || 0,
    cpm: parseFloat(row.cpm) || 0,
  };
}

// ── Insights desglosados por campaña (para cruzar con GA4 por utm_campaign) ──
async function getCampaignInsights(startDate, endDate) {
  if (!isConfigured()) throw new Error("NOT_CONFIGURED");

  const since = toISODate(startDate);
  const until = toISODate(endDate);
  const fields = "campaign_name,spend,impressions,clicks,ctr,cpc,cpm";
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

  const url = `https://graph.facebook.com/v20.0/${AD_ACCOUNT_ID}/insights?level=campaign&fields=${fields}&time_range=${timeRange}&limit=50&access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
  const resp = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Meta Marketing API error (${resp.status}): ${JSON.stringify(data.error || data)}`);
  }

  return (data.data || []).map(row => ({
    campaign: row.campaign_name || "",
    spend: parseFloat(row.spend) || 0,
    impressions: parseInt(row.impressions, 10) || 0,
    clicks: parseInt(row.clicks, 10) || 0,
    ctr: parseFloat(row.ctr) || 0,
    cpc: parseFloat(row.cpc) || 0,
    cpm: parseFloat(row.cpm) || 0,
  }));
}

module.exports = { isConfigured, getAccountInsights, getCampaignInsights };
