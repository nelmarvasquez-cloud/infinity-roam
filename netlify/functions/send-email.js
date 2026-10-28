// ============================================================
//  SEND-EMAIL.JS — EmailJS server-side
//  Vuelve a EmailJS que funcionaba correctamente
// ============================================================

const https = require("https");
const { corsHeaders, originAllowed, requestOrigin, isInternal, rateLimited, clientIp } = require("./lib/security");

const EMAILJS_SERVICE_ID  = process.env.EMAILJS_SERVICE_ID  || "service_3ewebpe";
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || "template_g6lndho";
const EMAILJS_PUBLIC_KEY  = process.env.EMAILJS_PUBLIC_KEY  || "";
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || "";

// Campos que las plantillas de EmailJS realmente usan. Cualquier otro se descarta.
const ALLOWED_FIELDS = new Set([
  "to_email","to_name","subject","html_body","message","plan_name","plan_price","transaction_id",
  "store_name","support_email","recovery_url","activation_code","smdp_address","qr_image","qr_codes_block",
  "china_notice","destination","duration","data_amount","order_total","quantity","customer_name","email",
  "brand","country","recipient_phone","amount","status","confirmation_number","plan_type","sender_name",
]);
const MAX_FIELD = 60000; // el QR en data-URI puede ser grande
const EMAIL_RE = /^[^\s@,;<>]{1,64}@[^\s@,;<>]{1,255}\.[^\s@,;<>]{2,}$/;

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const internal = isInternal(event);
  if (!internal && !originAllowed(requestOrigin(event))) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "forbidden" }) };
  }

  try {
    const raw = JSON.parse(event.body || "{}");
    if (!raw.to_email) return { statusCode: 400, headers, body: JSON.stringify({ error: "to_email required" }) };
    if (!EMAIL_RE.test(String(raw.to_email))) return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid to_email" }) };

    // Un solo destinatario, solo campos conocidos, tamaño acotado
    const params = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!ALLOWED_FIELDS.has(k)) continue;
      const val = typeof v === "string" || typeof v === "number" ? String(v) : "";
      if (val.length > MAX_FIELD) return { statusCode: 413, headers, body: JSON.stringify({ error: "field too large" }) };
      params[k] = typeof v === "number" ? v : val;
    }

    // Frecuencia: por IP y por destinatario (las llamadas internas no se limitan por IP)
    if (!internal && rateLimited("mail-ip:" + clientIp(event), 10, 60000)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: "rate_limited" }) };
    }
    if (rateLimited("mail-to:" + String(raw.to_email).toLowerCase(), 6, 3600000)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: "rate_limited_recipient" }) };
    }

    const payload = JSON.stringify({
      service_id:    EMAILJS_SERVICE_ID,
      template_id:   EMAILJS_TEMPLATE_ID,
      user_id:       EMAILJS_PUBLIC_KEY,
      accessToken:   EMAILJS_PRIVATE_KEY,
      template_params: params,
    });

    const result = await new Promise((resolve) => {
      const req = https.request({
        hostname: "api.emailjs.com",
        path: "/api/v1.0/email/send",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "origin": "https://infinity-roam.com",
        },
      }, (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("error", (e) => resolve({ status: 500, body: e.message }));
      req.write(payload); req.end();
    });

    if (result.status === 200) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } else {
      return { statusCode: 500, headers, body: JSON.stringify({ error: result.body }) };
    }

  } catch (err) {
    console.error("[send-email] Error:", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
