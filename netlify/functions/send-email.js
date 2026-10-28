// ============================================================
//  SEND-EMAIL.JS — EmailJS server-side
//  Vuelve a EmailJS que funcionaba correctamente
// ============================================================

const https = require("https");

const EMAILJS_SERVICE_ID  = process.env.EMAILJS_SERVICE_ID  || "service_3ewebpe";
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || "template_g6lndho";
const EMAILJS_PUBLIC_KEY  = process.env.EMAILJS_PUBLIC_KEY  || "";
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || "";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const params = JSON.parse(event.body || "{}");
    if (!params.to_email) return { statusCode: 400, headers, body: JSON.stringify({ error: "to_email required" }) };

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
