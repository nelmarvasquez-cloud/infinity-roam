// ============================================================
//  SECURITY.JS — Helpers compartidos de seguridad (Fase 1)
//  CORS restringido al dominio, detección de llamadas internas
//  (función → función) y límite de frecuencia básico.
// ============================================================

const crypto = require("crypto");

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

// Comparación de secretos en tiempo constante (evita deducir la contraseña por el tiempo
// de respuesta). Compara los hash SHA-256 para que no importe la longitud.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Autenticación de las páginas de administración (Bearer <contraseña>).
// Devuelve "ok", "denied" o "locked" (demasiados intentos fallidos desde la misma IP:
// 10 en 15 minutos; en memoria, por instancia — defensa básica contra fuerza bruta).
const authFails = new Map();
function adminAuth(event, secrets) {
  const ip = clientIp(event);
  const now = Date.now();
  const arr = (authFails.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (arr.length >= 10) { authFails.set(ip, arr); return "locked"; }
  const provided = headerOf(event, "authorization").replace(/^Bearer\s+/i, "").trim();
  if ((secrets || []).some((sec) => sec && safeEqual(provided, sec))) return "ok";
  arr.push(now);
  authFails.set(ip, arr);
  if (authFails.size > 5000) authFails.clear();
  return "denied";
}

// Escapa texto para meterlo en HTML (correos y paneles).
function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = { originAllowed, requestOrigin, corsHeaders, isInternal, internalHeaders, rateLimited, clientIp, headerOf, safeEqual, adminAuth, escapeHtml };
