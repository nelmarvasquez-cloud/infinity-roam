const https = require("https");
const { corsHeaders, rateLimited, clientIp } = require("./lib/security");
const paypal = require("./lib/paypal-verify");
const TIER2 = require("../../zendit_tier2.json"); // costo por offerId (se empaqueta con la función)

// ── Lista blanca de rutas que el navegador puede pedir a Zendit ──
const ALLOWED_GET = [
  /^\/esim\/offers$/,
  /^\/esim\/offers\/[A-Za-z0-9._-]{1,80}$/,
  /^\/esim\/purchases\/[A-Za-z0-9-]{1,60}$/,
  /^\/esim\/purchases\/[A-Za-z0-9-]{1,60}\/qrcode$/,
  /^\/topups\/offers$/,
  /^\/topups\/offers\/[A-Za-z0-9._-]{1,80}$/,
  /^\/topups\/purchases\/[A-Za-z0-9-]{1,60}$/,
];
const ALLOWED_POST = ["/esim/purchases", "/topups/purchases"];
const TX_RE = /^[A-Za-z0-9-]{6,60}$/;

function httpsRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ 
          status: res.statusCode, 
          buffer: buffer,
          contentType: res.headers["content-type"] || ""
        });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async function (event) {
  // Modo sandbox — activar con ZENDIT_SANDBOX_MODE=true en Netlify.
  // No asumo la URL exacta del sandbox de Zendit (varía según cuenta) —
  // se configura con ZENDIT_SANDBOX_BASE_URL. Si no se define, se usa el
  // mismo host de producción (algunos proveedores solo cambian de modo
  // según la API key, no el host) — revisa tu panel de Zendit para
  // confirmar cuál aplica a tu cuenta.
  const isSandbox = process.env.ZENDIT_SANDBOX_MODE === "true";
  const ZENDIT_KEY = isSandbox
    ? (process.env.ZENDIT_SANDBOX_API_KEY || process.env.ZENDIT_API_KEY)
    : process.env.ZENDIT_API_KEY;
  const ZENDIT_BASE = isSandbox
    ? (process.env.ZENDIT_SANDBOX_BASE_URL || "https://api.zendit.io/v1")
    : "https://api.zendit.io/v1";

  const CORS = corsHeaders(event);
  const json = (statusCode, obj) => ({ statusCode, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(obj) });

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  const path = event.queryStringParameters?.path || "/esim/offers";
  const method = event.httpMethod === "POST" ? "POST" : "GET";
  const body = method === "POST" ? event.body : null;

  // ── Validación de ruta (lista blanca) ──
  const pathOnly = path.split("?")[0];
  if (path.includes("..") || path.includes("//") || !path.startsWith("/")) return json(400, { error: "invalid_path" });
  const allowed = method === "POST" ? ALLOWED_POST.includes(pathOnly) : ALLOWED_GET.some((re) => re.test(pathOnly));
  if (!allowed) return json(403, { error: "path_not_allowed" });

  if (rateLimited("zendit:" + clientIp(event), 120, 60000)) return json(429, { error: "rate_limited" });

  // ── Compras: solo con un pedido de PayPal verificado y no reutilizado ──
  if (method === "POST") {
    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { return json(400, { error: "invalid_json" }); }
    const kind = pathOnly.startsWith("/esim") ? "esim" : "topup";
    const { offerId, transactionId } = payload;
    if (!offerId || !TX_RE.test(transactionId || "")) return json(400, { error: "invalid_purchase" });

    if (!paypal.isConfigured()) {
      console.warn("[zendit] PAYPAL_CLIENT_SECRET no configurado: compra NO verificada (modo de transición)");
    } else {
      const orderId = (event.headers["x-paypal-order-id"] || event.headers["X-PayPal-Order-Id"] || "").trim();
      let unitCost = null;
      if (kind === "esim") {
        const raw = TIER2[offerId];
        unitCost = raw == null ? null : Number(Array.isArray(raw) ? raw[0] : raw);
      } else {
        try {
          const r = await httpsRequest(`${ZENDIT_BASE}/topups/offers/${encodeURIComponent(offerId)}`, "GET", { "Authorization": ZENDIT_KEY });
          const o = JSON.parse(r.buffer.toString("utf8"));
          const p = o.price || o.cost || {};
          if (p.fixed > 0) unitCost = Number(p.fixed) / (Number(p.currencyDivisor) || 100);
        } catch (e) { /* se rechaza abajo */ }
      }
      if (!(unitCost > 0)) return json(400, { error: "unknown_offer" });
      let v;
      try { v = await paypal.verifyAndReserve({ orderId, transactionId, kind, offerId, unitCost }); }
      catch (e) { console.error("[zendit] verificación PayPal falló:", e.message); return json(503, { error: "payment_verification_unavailable" }); }
      if (!v.ok) { console.warn("[zendit] compra rechazada:", v.reason, offerId); return json(v.status || 402, { error: "payment_not_verified", reason: v.reason }); }
    }
  }

  if (!ZENDIT_KEY) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "ZENDIT_API_KEY not configured" }),
    };
  }

  try {
    const result = await httpsRequest(
      `${ZENDIT_BASE}${path}`,
      method,
      {
        "Authorization": ZENDIT_KEY,
        "Content-Type": "application/json",
        "Content-Length": body ? Buffer.byteLength(body) : 0,
      },
      body
    );

    const contentType = result.contentType;

    // Si la respuesta es una imagen (PNG, JPEG) — convertir a base64 y devolver en JSON
    if (contentType.includes("image/") || contentType.includes("png") || contentType.includes("jpeg")) {
      const base64 = result.buffer.toString("base64");
      return {
        statusCode: result.status,
        headers: {
          ...CORS,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ imageBase64: base64 }),
      };
    }

    // Si es JSON normal
    let data;
    try {
      data = JSON.parse(result.buffer.toString("utf8"));
    } catch(e) {
      // Si no es JSON ni imagen, intentar como base64 de todos modos
      // (algunos proveedores devuelven PNG sin Content-Type correcto)
      const str = result.buffer.toString("utf8");
      if (str.startsWith("\x89PNG") || result.buffer[0] === 0x89) {
        const base64 = result.buffer.toString("base64");
        return {
          statusCode: result.status,
          headers: { ...CORS, "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: base64 }),
        };
      }
      data = { rawResponse: str.substring(0, 200) };
    }

    return {
      statusCode: result.status,
      headers: {
        ...CORS,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
