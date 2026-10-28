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
const { supabase } = require("./lib/supabase-client");

const SITE_HOST = "infinity-roam.com";

function httpsPostJson(hostname, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
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
    const { transactionId, status, confirmation, error: zenditError, price, priceCurrencyDivisor } = payload;

    if (!transactionId) {
      return { statusCode: 200, body: "ignored (sin transactionId)" };
    }

    // Buscar el pedido que registramos nosotros mismos justo después del pago
    const lookup = await supabase("GET", `topup_orders?transaction_id=eq.${encodeURIComponent(transactionId)}&select=*`);
    const order = (lookup.data && lookup.data[0]) || null;

    if (!order) {
      console.error(`[topup-webhook] No se encontró la orden local para ${transactionId} — no se puede notificar por correo`);
      return { statusCode: 200, body: "ok (orden no encontrada localmente)" };
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

    const priceDisplay = price ? (price / (priceCurrencyDivisor || 100)).toFixed(2) : order.price.toFixed(2);

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
                <p style="font-size:14px;font-weight:bold;color:#000;margin:0 0 14px;">${order.recipient_phone}</p>
                <p style="font-size:13px;color:#888;margin:0 0 6px;">Número de confirmación</p>
                <p style="font-size:13px;font-weight:bold;color:#000;font-family:monospace;margin:0;">${(confirmation && confirmation.confirmationNumber) || "—"}</p>
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
                <p style="font-size:14px;color:#856404;margin:0;">Tu pago fue procesado, pero la recarga al número ${order.recipient_phone} no se pudo completar${zenditError && zenditError.message ? ": " + zenditError.message : "."} Escríbenos por WhatsApp con tu ID de transacción y te reembolsamos o reintentamos sin costo.</p>
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
