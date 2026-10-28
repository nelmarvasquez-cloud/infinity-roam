// ============================================================
//  META-CAPI.JS — Meta Conversions API (server-side)
//  Envía el mismo evento que el Pixel del navegador, usando el
//  mismo event_id, para que Meta deduplique automáticamente.
//
//  Requiere estas variables de entorno en Netlify:
//    META_PIXEL_ID
//    META_CONVERSIONS_API_TOKEN
//
//  Si no están configuradas, la función responde 200 sin error
//  y sin enviar nada — no rompe el sitio ni el tracking del Pixel.
// ============================================================

const crypto = require("crypto");

function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const PIXEL_ID = process.env.META_PIXEL_ID;
  const ACCESS_TOKEN = process.env.META_CONVERSIONS_API_TOKEN;

  // Sin configurar todavía: no-op seguro, no rompe nada en el frontend.
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true, reason: "META_PIXEL_ID o META_CONVERSIONS_API_TOKEN no configurados" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { event_name, event_id, event_source_url, custom_data, email, action_source } = body;

    if (!event_name || !event_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "event_name y event_id son requeridos" }) };
    }

    const userData = {
      client_user_agent: event.headers["user-agent"] || "",
    };
    const hashedEmail = sha256(email);
    if (hashedEmail) userData.em = [hashedEmail];

    // IP del cliente, si Netlify la expone en los headers
    const clientIp = event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"];
    if (clientIp) userData.client_ip_address = clientIp;

    const payload = {
      data: [
        {
          event_name,
          event_time: Math.floor(Date.now() / 1000),
          event_id,
          event_source_url: event_source_url || "",
          action_source: action_source || "website",
          user_data: userData,
          custom_data: custom_data || {},
        },
      ],
    };

    const url = `https://graph.facebook.com/v20.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await resp.json();

    if (!resp.ok) {
      console.error("[meta-capi] Error de Meta:", JSON.stringify(result));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, meta_error: result }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, result }) };
  } catch (err) {
    console.error("[meta-capi] Error:", err.message);
    // Nunca romper el frontend por un error de tracking server-side.
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
