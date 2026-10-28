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

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const order = JSON.parse(event.body || "{}");
    if (!order.transactionId || !order.email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "transactionId y email son requeridos" }) };
    }

    const row = {
      transaction_id: order.transactionId,
      email: order.email,
      customer_name: order.customerName || order.email.split("@")[0],
      plan_name: order.planName || "",
      plan_price: order.planPrice || 0,
      offer_id: order.offerId || "",
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
      { "Prefer": "resolution=merge-duplicates,return=minimal" }
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
