// ============================================================
//  PENDING-ORDER.JS — Registra órdenes cuyo aprovisionamiento
//  de Zendit no terminó a tiempo, para que retry-pending-esims.js
//  (función programada) las reintente en segundo plano y reenvíe
//  el correo de confirmación con el QR/código real cuando esté listo.
//
//  Llamada desde confirmation.js SOLO cuando ya se agotaron los
//  intentos normales (ver maxAttempts en confirmation.js). No
//  reemplaza el correo inmediato — es un respaldo adicional.
// ============================================================

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
  if (rateLimited("pending:" + clientIp(event), 20, 60000)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "rate_limited" }) };
  }
  const str = (v, max) => String(v == null ? "" : v).slice(0, max);
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
  const TX_RE = /^[A-Za-z0-9-]{6,60}$/;

  try {
    const order = JSON.parse(event.body || "{}");
    if (!order.transactionId || !order.email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "transactionId y email son requeridos" }) };
    }

    if (!TX_RE.test(String(order.transactionId)) || !EMAIL_RE.test(String(order.email))) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "datos inválidos" }) };
    }
    const row = {
      transaction_id: String(order.transactionId),
      email: str(order.email, 254),
      customer_name: str(order.customerName || String(order.email).split("@")[0], 100),
      plan_name: str(order.planName, 200),
      plan_price: Math.min(Math.max(Number(order.planPrice) || 0, 0), 5000),
      offer_id: str(order.offerId, 100),
      resolved: false,
      attempts: 0,
      last_checked_at: null,
      resolved_at: null,
    };

    // Upsert por transaction_id — si el usuario recarga confirmation.html
    // varias veces, no se duplican filas ni se reinicia el contador de intentos.
    const result = await supabase(
      "POST",
      "pending_esim_orders?on_conflict=transaction_id",
      row,
      { "Prefer": "resolution=ignore-duplicates,return=minimal" }
    );

    if (result.status >= 200 && result.status < 300) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    console.error("[pending-order] Supabase error:", result.status, result.data);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "supabase_error", detail: result.data }) };

  } catch (err) {
    console.error("[pending-order] Error:", err.message);
    // No queremos que un fallo aquí rompa la experiencia del cliente —
    // responde 200 igual; el peor caso es que no haya reintento automático,
    // pero el correo inmediato (aunque vacío) ya se intentó por otro lado.
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
