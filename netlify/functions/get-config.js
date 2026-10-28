// ============================================================
//  GET-CONFIG.JS — Devuelve configuración pública al frontend
//  Las claves sensibles viven en Netlify env vars, no en código.
//  IMPORTANTE: este endpoint es PÚBLICO — solo devuelve valores que son
//  públicos por diseño (client ID de PayPal, ID de pixel, etc.). NUNCA
//  agregar aquí claves privadas (Zendit, secret de PayPal, Supabase…).
// ============================================================

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/javascript",
    "Cache-Control": "no-store, max-age=0",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const config = `
window.IR_RUNTIME_CONFIG = {
  PAYPAL_CLIENT_ID: ${JSON.stringify(process.env.PAYPAL_CLIENT_ID || "")},
  EMAILJS_PUBLIC_KEY: ${JSON.stringify(process.env.EMAILJS_PUBLIC_KEY || "")},
  META_PIXEL_ID: ${JSON.stringify(process.env.META_PIXEL_ID || "")},
  CLARITY_PROJECT_ID: ${JSON.stringify(process.env.CLARITY_PROJECT_ID || "")},
};
`;

  return { statusCode: 200, headers, body: config };
};
