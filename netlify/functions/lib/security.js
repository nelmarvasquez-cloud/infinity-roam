// ============================================================
//  SECURITY.JS — Helpers compartidos de seguridad (Fase 1)
//  CORS restringido al dominio, detección de llamadas internas
//  (función → función) y límite de frecuencia básico.
// ============================================================

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://infinity-roam.com,https://www.infinity-roam.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Los Deploy Previews de Netlify (deploy-preview-N--sitio.netlify.app) y la
// URL del propio deploy también se permiten para poder probar antes de publicar.
function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (process.env.URL && origin === process.env.URL) return true;
  if (process.env.DEPLOY_PRIME_URL && origin === process.env.DEPLOY_PRIME_URL) return true;
  return /^https:\/\/(deploy-preview-\d+|[a-z0-9-]+)--genuine-travesseiro-3f3b01\.netlify\.app$/.test(origin);
}

function headerOf(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || "";
}

function requestOrigin(event) {
  const o = headerOf(event, "origin");
  if (o) return o;
  const ref = headerOf(event, "referer");
  try { return ref ? new URL(ref).origin : ""; } catch { return ""; }
}

// Cabeceras CORS: solo refleja el origen si está permitido.
function corsHeaders(event, extra = {}) {
  const origin = requestOrigin(event);
  const h = {
    "Access-Control-Allow-Headers": "Content-Type, X-PayPal-Order-Id, X-Internal-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
    ...extra,
  };
  h["Access-Control-Allow-Origin"] = originAllowed(origin) ? origin : ALLOWED_ORIGINS[0];
  return h;
}

// Llamada interna (otra función nuestra). Si INTERNAL_API_KEY no está
// configurada, no hay forma de distinguirla: se devuelve false.
function isInternal(event) {
  const key = process.env.INTERNAL_API_KEY;
  return !!key && headerOf(event, "x-internal-key") === key;
}

function internalHeaders() {
  return process.env.INTERNAL_API_KEY ? { "X-Internal-Key": process.env.INTERNAL_API_KEY } : {};
}

// Límite de frecuencia en memoria (por instancia de la función; es una
// defensa básica, no una garantía global).
const buckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 5000) buckets.clear();
  return false;
}

function clientIp(event) {
  return headerOf(event, "x-nf-client-connection-ip") ||
    (headerOf(event, "x-forwarded-for").split(",")[0] || "").trim() || "unknown";
}

module.exports = { originAllowed, requestOrigin, corsHeaders, isInternal, internalHeaders, rateLimited, clientIp, headerOf };
