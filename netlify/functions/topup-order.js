// ============================================================
//  CREATE-TOPUP-ORDER.JS — Registra un envío de saldo recién pagado
// ============================================================
// Se llama justo después de crear la compra en Zendit (desde
// topup-checkout.js). Guarda el email del remitente en Supabase,
// porque el webhook de Zendit (topup-webhook.js) NO incluye esa
// información — solo sabe del transactionId y los datos de la
// operadora/destinatario, así que sin este registro no sabríamos
// a quién confirmarle por correo cuando la recarga se complete.

const { supabase } = require("./lib/supabase-client");
const { corsHeaders, originAllowed, requestOrigin, isInternal, rateLimited, clientIp } = require("./lib/security");

const baseHeaders = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  const headers = { ...baseHeaders, ...corsHeaders(event) };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Solo desde nuestro sitio (o llamadas internas) y con límite de frecuencia
  if (!originAllowed(requestOrigin(event)) && !isInternal(event)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "forbidden" }) };
  }
  if (rateLimited("topup:" + clientIp(event), 20, 60000)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "rate_limited" }) };
  }
  const str = (v, max) => String(v == null ? "" : v).slice(0, max);
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
  const TX_RE = /^[A-Za-z0-9-]{6,60}$/;

  try {
    const order = JSON.parse(event.body || "{}");
    if (!order.transactionId || !order.senderEmail) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "transactionId y senderEmail son requeridos" }) };
    }

    if (!TX_RE.test(String(order.transactionId)) || !EMAIL_RE.test(String(order.senderEmail))) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "datos inválidos" }) };
    }
    const row = {
      transaction_id: String(order.transactionId),
      sender_email: str(order.senderEmail, 254),
      recipient_phone: str(order.recipientPhone, 30),
      brand: str(order.brand, 100),
      country: str(order.country, 100),
      price: Math.min(Math.max(Number(order.price) || 0, 0), 5000),
      status: "PENDING",
      confirmation_number: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result = await supabase(
      "POST",
      "topup_orders?on_conflict=transaction_id",
      row,
      { "Prefer": "resolution=ignore-duplicates,return=minimal" }
    );

    if (result.status >= 200 && result.status < 300) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    console.error("[create-topup-order] Supabase error:", result.status, result.data);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "supabase_error", detail: result.data }) };

  } catch (err) {
    console.error("[create-topup-order] Error:", err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
