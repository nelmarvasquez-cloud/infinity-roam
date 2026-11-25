// ============================================================
//  TOPUP-WEBHOOK.JS — Recibe la confirmación de Zendit (Mobile Top-Up)
// ============================================================
// URL a registrar en el panel de Zendit (Configuración → Webhooks →
// Mobile Top Up): https://infinity-roam.com/.netlify/functions/topup-webhook
//
// A diferencia del eSIM (que no tiene webhook y por eso construimos
// todo el sistema de polling + reintento en confirmation.js), Zendit
// SÍ ofrece webhook para Mobile Top-Up — así que aquí no hace falta
// nada de eso: Zendit nos avisa una sola vez cuando termina (ya sea
// al instante o tras sus reintentos internos, hasta 24h), y en ese
// momento enviamos el correo. Más simple y más confiable.

const https = require("https");
const { internalHeaders, escapeHtml } = require("./lib/security");
const { supabase } = require("./lib/supabase-client");

const SITE_HOST = "infinity-roam.com";

// Consulta el estado REAL de la recarga directamente en Zendit (el webhook no lleva firma:
// cualquiera podría enviar un POST falso con status "DONE" para disparar correos o cambiar pedidos).
function zenditGetPurchase(transactionId) {
  return new Promise((resolve) => {
    const key = process.env.ZENDIT_API_KEY;
    if (!key) return resolve({ status: 500, data: null });
    const req = https.request({
      hostname: "api.zendit.io", path: `/v1/topups/purchases/${encodeURIComponent(transactionId)}`, method: "GET",
      headers: { Authorization: key }, timeout: 15000,
    }, (res) => {
      let d = ""; res.on("data", (c) => { d += c; });
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || "null") }); } catch { resolve({ status: res.statusCode, data: null }); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 500, data: null }));
    req.end();
  });
}

function httpsPostJson(hostname, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...internalHeaders() },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "{}") }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on("error", () => resolve({ status: 500, data: {} }));
    req.write(payload);
    req.end();
  });
}

exports.handler = async function (event) {
  // Zendit espera 200 rápido — cualquier error nuestro no debe hacer
  // que Zendit piense que el webhook falló y lo reintente indefinidamente.
  try {
    const payload = JSON.parse(event.body || "{}");
    const { transactionId } = payload;

    if (!transactionId || !/^[A-Za-z0-9-]{6,60}$/.test(String(transactionId))) {
      return { statusCode: 200, body: "ignored (sin transactionId)" };
    }

    // Buscar el pedido que registramos nosotros mismos justo después del pago
    const lookup = await supabase("GET", `topup_orders?transaction_id=eq.${encodeURIComponent(transactionId)}&select=*`);
    const order = (lookup.data && lookup.data[0]) || null;

    if (!order) {
      console.error(`[topup-webhook] No se encontró la orden local para ${transactionId} — no se puede notificar por correo`);
      return { statusCode: 200, body: "ok (orden no encontrada localmente)" };
    }

    // No se confía en el contenido del webhook: el estado, la confirmación y el precio salen de Zendit.
    const real = await zenditGetPurchase(transactionId);
    if (real.status !== 200 || !real.data || typeof real.data !== "object") {
      console.error(`[topup-webhook] No se pudo verificar ${transactionId} en Zendit (HTTP ${real.status})`);
      return { statusCode: 503, body: "verification unavailable" }; // Zendit reintenta
    }
    const { status, confirmation, error: zenditError, price, priceCurrencyDivisor } = real.data;

    // Idempotencia: un mismo estado final no vuelve a enviar correo (evita spam por webhooks repetidos).
    if ((status === "DONE" || status === "FAILED") && order.status === status) {
      return { statusCode: 200, body: "ok (ya procesado)" };
    }

    // Actualizar estado en Supabase
    await supabase(
      "PATCH",
      `topup_orders?transaction_id=eq.${encodeURIComponent(transactionId)}`,
      {
        status: status || "UNKNOWN",
        confirmation_number: (confirmation && confirmation.confirmationNumber) || null,
        updated_at: new Date().toISOString(),
      }
    );

    // Solo se envía correo cuando el estado es final (éxito o fallo) —
    // los estados intermedios (PENDING/ACCEPTED/AUTHORIZED/IN_PROGRESS)
    // no generan correo todavía, para no mandar 3-4 correos por la misma orden.
    if (status !== "DONE" && status !== "FAILED") {
      return { statusCode: 200, body: `ok (estado intermedio: ${status})` };
    }

    const priceDisplay = (typeof price === "number" && price > 0) ? (price / (Number(priceCurrencyDivisor) || 100)).toFixed(2) : Number(order.price || 0).toFixed(2);

    const emailPayload = status === "DONE"
      ? {
          to_email: order.sender_email,
          to_name: order.sender_email.split("@")[0],
          subject: `¡Tu envío de saldo fue exitoso! — Infinity Roam`,
          order_id: transactionId,
          plan_name: `Recarga ${order.brand} — ${order.country}`,
          plan_price: `$${priceDisplay} USD`,
          transaction_id: transactionId,
          recovery_url: "",
          qr_image: "",
          activation_code: "",
          smdp_address: "",
          qr_codes_block: `
            <table style="background:#f5f5f7;border-radius:12px;padding:20px;margin:0 0 16px;width:100%;" cellspacing="0" cellpadding="0">
              <tr><td>
                <p style="font-size:13px;color:#888;margin:0 0 6px;">Número recargado</p>
                <p style="font-size:14px;font-weight:bold;color:#000;margin:0 0 14px;">${escapeHtml(order.recipient_phone)}</p>
                <p style="font-size:13px;color:#888;margin:0 0 6px;">Número de confirmación</p>
                <p style="font-size:13px;font-weight:bold;color:#000;font-family:monospace;margin:0;">${escapeHtml((confirmation && confirmation.confirmationNumber) || "—")}</p>
              </td></tr>
            </table>`,
          china_notice: "",
        }
      : {
          to_email: order.sender_email,
          to_name: order.sender_email.split("@")[0],
          subject: `No pudimos completar tu envío de saldo — Infinity Roam`,
          order_id: transactionId,
          plan_name: `Recarga ${order.brand} — ${order.country}`,
          plan_price: `$${priceDisplay} USD`,
          transaction_id: transactionId,
          recovery_url: "",
          qr_image: "", activation_code: "", smdp_address: "",
          qr_codes_block: `
            <table style="background:#fff3cd;border:1px solid #ffc107;border-radius:12px;padding:20px;margin:0 0 16px;width:100%;" cellspacing="0" cellpadding="0">
              <tr><td>
                <p style="font-size:14px;color:#856404;margin:0;">Tu pago fue procesado, pero la recarga al número ${escapeHtml(order.recipient_phone)} no se pudo completar${zenditError && zenditError.message ? ": " + escapeHtml(zenditError.message) : "."} Escríbenos por WhatsApp con tu ID de transacción y te reembolsamos o reintentamos sin costo.</p>
              </td></tr>
            </table>`,
          china_notice: "",
        };

    await httpsPostJson(SITE_HOST, "/.netlify/functions/send-email", emailPayload);

    return { statusCode: 200, body: "ok" };

  } catch (err) {
    console.error("[topup-webhook] Error:", err.message);
    // Igual respondemos 200 — un error nuestro no debe activar los
    // reintentos de Zendit para este webhook.
    return { statusCode: 200, body: "error interno registrado" };
  }
};
