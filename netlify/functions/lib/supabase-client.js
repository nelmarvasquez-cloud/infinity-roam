// ============================================================
//  SUPABASE-CLIENT.JS — Helper compartido para llamadas REST a Supabase
//  Mismo patrón que ya usa netlify/functions/referral.js — se extrajo
//  aquí como módulo reutilizable para no duplicar la lógica en cada
//  función nueva que necesite Supabase. No modifica referral.js
//  (que ya funciona en producción) para no arriesgar esa ruta.
// ============================================================

const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

/**
 * Llama a la API REST de Supabase (PostgREST).
 * @param {"GET"|"POST"|"PATCH"|"DELETE"} method
 * @param {string} path - ej. "pending_esim_orders?transaction_id=eq.IR-123"
 * @param {object|null} body
 * @param {object} extraHeaders - ej. { Prefer: "resolution=merge-duplicates" } para upsert
 */
async function supabase(method, path, body, extraHeaders = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY no configuradas");
  }
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: SUPABASE_URL.replace("https://", ""),
      path: `/rest/v1/${path}`,
      method,
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer": "return=representation",
        ...extraHeaders,
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data || "null") }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { supabase };
