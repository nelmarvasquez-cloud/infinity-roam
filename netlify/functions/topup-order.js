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
    if (!order.transactionId || !order.senderEmail) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "transactionId y senderEmail son requeridos" }) };
    }

    const row = {
      transaction_id: order.transactionId,
      sender_email: order.senderEmail,
      recipient_phone: order.recipientPhone || "",
      brand: order.brand || "",
      country: order.country || "",
      price: order.price || 0,
      status: "PENDING",
      confirmation_number: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result = await supabase(
      "POST",
      "topup_orders?on_conflict=transaction_id",
      row,
      { "Prefer": "resolution=merge-duplicates,return=minimal" }
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
