// ============================================================
//  GA4-CLIENT.JS — Capa 1: cliente crudo de la GA4 Data API
//  Solo se encarga de autenticar y ejecutar consultas. No conoce
//  nada sobre el dashboard, el embudo ni las métricas de negocio.
//
//  Variables de entorno requeridas:
//    GA4_PROPERTY_ID
//    GA4_SERVICE_ACCOUNT_EMAIL
//    GA4_SERVICE_ACCOUNT_PRIVATE_KEY
// ============================================================

const crypto = require("crypto");

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const SA_EMAIL = process.env.GA4_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = (process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

function isConfigured() {
  return !!(PROPERTY_ID && SA_EMAIL && SA_KEY);
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Cache del access_token en memoria (dura ~1h, se reusa entre invocaciones
//    "calientes" de la función para no regenerar el JWT en cada request) ──
let _tokenCache = { token: null, expiresAt: 0 };

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.token && _tokenCache.expiresAt > now + 60) {
    return _tokenCache.token;
  }

  const header = { alg: "RS256", typ: "JWT" };
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

  const resp = await fetchWithTimeout(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    },
    REQUEST_TIMEOUT_MS
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error("OAuth error: " + JSON.stringify(data));

  _tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) };
  return data.access_token;
}

// ── Ejecuta un runReport con reintentos ante errores transitorios ──
async function runReport(body, attempt = 0) {
  if (!isConfigured()) {
    throw new Error("NOT_CONFIGURED");
  }
  try {
    const accessToken = await getAccessToken();
    const resp = await fetchWithTimeout(
      `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS
    );
    const data = await resp.json();

    if (!resp.ok) {
      // 429/503 => reintentar; el resto son errores de la consulta, no reintentar
      if ((resp.status === 429 || resp.status === 503) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        return runReport(body, attempt + 1);
      }
      throw new Error(`GA4 API error (${resp.status}): ${JSON.stringify(data)}`);
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError" && attempt < MAX_RETRIES) {
      return runReport(body, attempt + 1);
    }
    throw err;
  }
}

// ── Ejecuta varias consultas en paralelo, cada una aislada:
//    si una falla, no tumba las demás (se marca con error propio) ──
async function runReportsBatch(namedQueries) {
  const names = Object.keys(namedQueries);
  const results = await Promise.allSettled(names.map(n => runReport(namedQueries[n])));
  const out = {};
  names.forEach((name, i) => {
    const r = results[i];
    out[name] = r.status === "fulfilled" ? { ok: true, data: r.value } : { ok: false, error: r.reason.message };
  });
  return out;
}

module.exports = { isConfigured, runReport, runReportsBatch, PROPERTY_ID };
