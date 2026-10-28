// ============================================================
//  RETRY-PENDING-ESIMS.JS — Función programada (cron, ver netlify.toml)
//
//  Corre cada 5 minutos. Busca órdenes en pending_esim_orders que
//  quedaron sin QR/código de activación (ver pending-order.js y el
//  fallback en confirmation.js), vuelve a preguntarle a Zendit, y si
//  ya está listo, reenvía el correo de confirmación con los datos
//  reales y marca la orden como resuelta.
//
//  Reutiliza las funciones YA existentes (no duplica credenciales
//  ni lógica de envío):
//    - netlify/functions/zendit.js   → proxy autenticado a Zendit
//    - netlify/functions/send-email.js → envío vía EmailJS
//
//  NOTA para mantenimiento: la extracción de qrBase64/activationCode/
//  smdpAddress de la respuesta de Zendit está duplicada aquí y en
//  confirmation.js (frontend) porque uno corre en el navegador y
//  el otro en Node — no hay un módulo compartido entre ambos entornos
//  todavía. Si cambia la estructura de la respuesta de Zendit, hay
//  que actualizar los dos lados. Candidato a refactor futuro si se
//  agrega un bundler compartido.
// ============================================================

const https = require("https");
const { internalHeaders } = require("./lib/security");
const { supabase } = require("./lib/supabase-client");

const SITE_HOST = "infinity-roam.com";
const MAX_ATTEMPTS = 20; // ~100 min de reintentos (20 x cada 5 min) antes de dejar de intentar

function httpsGetJson(hostname, path) {
  return new Promise((resolve) => {
    https.get({ hostname, path, headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "{}") }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    }).on("error", () => resolve({ status: 500, data: {} }));
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

// Misma lógica de extracción que confirmation.js — ver nota arriba.
function extractZenditFields(data) {
  const qrBase64 =
    data.imageBase64 || data.qrCode || data.image || data.qr || data.qrImage || data.base64 ||
    (data.esim && data.esim.imageBase64) || (data.data && data.data.imageBase64) || null;

  const activationCode =
    (data.confirmation && data.confirmation.activationCode) ||
    data.activationCode || data.manualCode ||
    (data.esim && data.esim.activationCode) || null;

  const smdpAddress =
    (data.confirmation && data.confirmation.smdpAddress) ||
    data.smdpAddress || data.smDpAddress ||
    (data.esim && data.esim.smdpAddress) || null;

  return { qrBase64, activationCode, smdpAddress };
}

function formatPrice(amount) {
  const n = Number(amount) || 0;
  return new Intl.NumberFormat("es-PA", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
}

async function resendConfirmationEmail(order, activationCode, smdpAddress) {
  const recoveryUrl = `https://${SITE_HOST}/my-esim.html?id=${order.transaction_id}`;
  const isChinaPlan = order.offer_id && order.offer_id.includes("-CN-");

  const payload = {
    to_email: order.email,
    to_name: order.customer_name || order.email.split("@")[0],
    subject: isChinaPlan
      ? "¡Tu eSIM para China está lista! Instálala ANTES de llegar — Infinity Roam"
      : "¡Tu eSIM está lista! — Infinity Roam",
    order_id: order.transaction_id,
    plan_name: order.plan_name,
    plan_price: formatPrice(order.plan_price) + " USD",
    transaction_id: order.transaction_id,
    recovery_url: recoveryUrl,
    qr_image: "",
    activation_code: activationCode || "",
    smdp_address: smdpAddress || "",
    china_notice: isChinaPlan
      ? '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:10px;padding:16px;margin:0 0 20px;font-size:14px;color:#856404;">⚠️ IMPORTANTE: Instala y activa tu eSIM ANTES de llegar a China. Una vez dentro del país no podrás descargar la app ni acceder al QR por internet. Tu eSIM te dará acceso a WhatsApp, Google, Instagram y YouTube sin restricciones gracias al enrutamiento internacional.</div>'
      : "",
  };

  return httpsPostJson(SITE_HOST, "/.netlify/functions/send-email", payload);
}

exports.handler = async function () {
  try {
    const pending = await supabase(
      "GET",
      `pending_esim_orders?resolved=eq.false&attempts=lt.${MAX_ATTEMPTS}&select=*&order=created_at.asc&limit=15`
    );

    if (pending.status < 200 || pending.status >= 300 || !Array.isArray(pending.data)) {
      console.error("[retry-pending-esims] Error leyendo Supabase:", pending.status, pending.data);
      return { statusCode: 200, body: "no-op (supabase read error)" };
    }

    const orders = pending.data;
    console.log(`[retry-pending-esims] ${orders.length} orden(es) pendiente(s) por revisar`);

    for (const order of orders) {
      try {
        const zenditRes = await httpsGetJson(
          SITE_HOST,
          `/.netlify/functions/zendit?path=${encodeURIComponent(`/esim/purchases/${order.transaction_id}/qrcode`)}`
        );
        const { qrBase64, activationCode, smdpAddress } = extractZenditFields(zenditRes.data || {});

        if (qrBase64 || activationCode) {
          const emailResult = await resendConfirmationEmail(order, activationCode, smdpAddress);
          if (emailResult.status === 200 && emailResult.data && emailResult.data.ok) {
            await supabase(
              "PATCH",
              `pending_esim_orders?transaction_id=eq.${encodeURIComponent(order.transaction_id)}`,
              { resolved: true, resolved_at: new Date().toISOString(), attempts: (order.attempts || 0) + 1, last_checked_at: new Date().toISOString() }
            );
            console.log(`[retry-pending-esims] ✅ Resuelto y correo reenviado: ${order.transaction_id}`);
          } else {
            console.error(`[retry-pending-esims] Zendit listo pero falló el reenvío de correo para ${order.transaction_id}:`, emailResult.data);
            // No se marca resuelto — se reintentará el envío en la próxima corrida.
            await supabase(
              "PATCH",
              `pending_esim_orders?transaction_id=eq.${encodeURIComponent(order.transaction_id)}`,
              { attempts: (order.attempts || 0) + 1, last_checked_at: new Date().toISOString() }
            );
          }
        } else {
          await supabase(
            "PATCH",
            `pending_esim_orders?transaction_id=eq.${encodeURIComponent(order.transaction_id)}`,
            { attempts: (order.attempts || 0) + 1, last_checked_at: new Date().toISOString() }
          );
          console.log(`[retry-pending-esims] Aún sin datos para ${order.transaction_id} (intento ${(order.attempts || 0) + 1}/${MAX_ATTEMPTS})`);
        }
      } catch (innerErr) {
        console.error(`[retry-pending-esims] Error procesando ${order.transaction_id}:`, innerErr.message);
      }
    }

    return { statusCode: 200, body: `Procesadas ${orders.length} orden(es)` };

  } catch (err) {
    console.error("[retry-pending-esims] Error general:", err.message);
    return { statusCode: 200, body: "error: " + err.message };
  }
};
