// ============================================================
//  PAYPAL-VERIFY.JS — Verifica en PayPal que un pedido esté pagado
//  y registra su uso para que no se pueda reutilizar (Fase 1).
//
//  Requiere en Netlify: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
//  (opcional PAYPAL_API_BASE; por defecto producción).
//  Requiere la tabla paypal_order_uses (ver SQL en docs/).
// ============================================================

const https = require("https");
const { supabase } = require("./supabase-client");

const PAYPAL_BASE = process.env.PAYPAL_API_BASE || "https://api-m.paypal.com";
const PAYPAL_REAL_PCT = 0.054;
const PAYPAL_REAL_FIXED = 0.30;

function floorPrice(cost) {
  return Math.ceil(((cost + PAYPAL_REAL_FIXED) / (1 - PAYPAL_REAL_PCT)) * 100) / 100;
}

function paypalRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(PAYPAL_BASE);
    const req = https.request({ hostname: u.hostname, path, method, timeout: 15000, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || "null") }); } catch { resolve({ status: res.statusCode, data: null }); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

let tokenCache = { token: null, exp: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const body = "grant_type=client_credentials";
  const r = await paypalRequest("POST", "/v1/oauth2/token", {
    Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body),
  }, body);
  if (r.status !== 200 || !r.data?.access_token) throw new Error("paypal_token_failed_" + r.status);
  tokenCache = { token: r.data.access_token, exp: Date.now() + (r.data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

function isConfigured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

/**
 * Devuelve { ok, paid, currency, reason } para un pedido de PayPal.
 * Solo es válido si está COMPLETED y la captura está COMPLETED.
 */
async function getPaidAmount(orderId) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(orderId || "")) return { ok: false, reason: "invalid_order_id" };
  const token = await getToken();
  const r = await paypalRequest("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { Authorization: `Bearer ${token}` });
  if (r.status !== 200 || !r.data) return { ok: false, reason: "order_not_found" };
  if (r.data.status !== "COMPLETED") return { ok: false, reason: "order_not_completed" };
  const caps = (r.data.purchase_units || []).flatMap((u) => u.payments?.captures || []);
  const done = caps.filter((c) => c.status === "COMPLETED");
  if (!done.length) return { ok: false, reason: "no_completed_capture" };
  const paid = done.reduce((s, c) => s + Number(c.amount?.value || 0), 0);
  return { ok: true, paid: Math.round(paid * 100) / 100, currency: done[0].amount?.currency_code || "USD", payerEmail: r.data.payer?.email_address || null };
}

/**
 * Verifica pago + reserva el uso. kind: "esim" | "topup".
 * unitCost: costo de UNA unidad. Cada transaction_id distinto cuenta como
 * una unidad; el mismo transaction_id es reintento (idempotente).
 */
async function verifyAndReserve({ orderId, transactionId, kind, offerId, unitCost }) {
  const pay = await getPaidAmount(orderId);
  if (!pay.ok) return { ok: false, status: 402, reason: pay.reason };
  if (pay.currency !== "USD") return { ok: false, status: 402, reason: "bad_currency" };

  const unitFloor = floorPrice(unitCost);
  const q = await supabase("GET", `paypal_order_uses?paypal_order_id=eq.${encodeURIComponent(orderId)}&select=transaction_id,kind`);
  if (q.status !== 200 || !Array.isArray(q.data)) return { ok: false, status: 503, reason: "replay_store_unavailable" };

  if (q.data.some((r) => r.transaction_id === transactionId)) return { ok: true, paid: pay.paid, reused: true };
  if (q.data.some((r) => r.kind !== kind)) return { ok: false, status: 409, reason: "order_kind_mismatch" };

  const units = q.data.length + 1;
  // Tolerancia de 1 centavo por unidad por redondeos.
  if (pay.paid + 0.01 * units < unitFloor * units) return { ok: false, status: 402, reason: "amount_below_floor" };

  const ins = await supabase("POST", "paypal_order_uses", {
    paypal_order_id: orderId, transaction_id: transactionId, kind, offer_id: offerId, amount_paid: pay.paid,
  }, { Prefer: "return=minimal" });
  if (ins.status < 200 || ins.status >= 300) return { ok: false, status: 409, reason: "reserve_failed" };
  return { ok: true, paid: pay.paid };
}

module.exports = { isConfigured, getPaidAmount, verifyAndReserve, floorPrice };
