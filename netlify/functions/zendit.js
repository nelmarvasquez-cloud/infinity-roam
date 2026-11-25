const https = require("https");
const { corsHeaders, rateLimited, clientIp, originAllowed, requestOrigin, isInternal } = require("./lib/security");
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
const OFFER_RE = /^[A-Za-z0-9._-]{1,80}$/;
const PHONE_RE = /^\+?[0-9]{6,15}$/;

// Zendit devuelve en las ofertas de eSIM el costo de la cuenta (cost) y el margen
// (price.margin / cost.discount), con los que se deduce el costo real. El navegador
// no los necesita (el precio de venta sale de zendit_prices.json / del catálogo),
// así que se eliminan antes de responder. Solo aplica a /esim/offers*.
function stripEsimCosts(data) {
  const clean = (o) => {
    if (!o || typeof o !== "object") return o;
    delete o.cost;
    if (o.price && typeof o.price === "object") { delete o.price.margin; delete o.price.fee; delete o.price.feePct; }
    return o;
  };
  if (data && Array.isArray(data.list)) data.list.forEach(clean); else clean(data);
  return data;
}

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
  let forwardBody = body;
  if (method === "POST") {
    // Interruptor de emergencia: ZENDIT_PURCHASES_DISABLED=true en Netlify detiene toda compra.
    if (process.env.ZENDIT_PURCHASES_DISABLED === "true") return json(503, { error: "purchases_disabled" });

    // Las compras solo salen de nuestro sitio (o llamadas internas). El Origin lo puede falsificar
    // un script, así que esto es una capa más; la defensa real es la verificación del pago de abajo.
    if (!originAllowed(requestOrigin(event)) && !isInternal(event)) return json(403, { error: "forbidden" });
    if (rateLimited("zendit-buy:" + clientIp(event), 10, 600000)) return json(429, { error: "rate_limited" });

    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { return json(400, { error: "invalid_json" }); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json(400, { error: "invalid_purchase" });
    const kind = pathOnly.startsWith("/esim") ? "esim" : "topup";
    const { offerId, transactionId } = payload;
    if (!OFFER_RE.test(String(offerId || "")) || !TX_RE.test(String(transactionId || ""))) return json(400, { error: "invalid_purchase" });

    // Se reenvía a Zendit SOLO lo validado (no el cuerpo original): evita campos extra o
    // claves duplicadas que Zendit pudiera interpretar distinto a como las validamos aquí.
    if (kind === "esim") {
      if (!String(offerId).startsWith("ESIM-")) return json(400, { error: "unknown_offer" });
      forwardBody = JSON.stringify({ offerId, transactionId });
    } else {
      const phone = String(payload.recipientPhoneNumber || "");
      if (!PHONE_RE.test(phone)) return json(400, { error: "invalid_purchase" });
      const out = { offerId, recipientPhoneNumber: phone, transactionId };
      if (payload.value != null) {
        const v = payload.value;
        if (typeof v !== "object" || typeof v.type !== "string" || !(Number(v.value) > 0)) return json(400, { error: "invalid_purchase" });
        out.value = { type: v.type, value: Number(v.value) };
      }
      forwardBody = JSON.stringify(out);
    }

    // Sin verificación de pago NO se compra (antes: "modo de transición" que dejaba pasar la compra).
    // Solo el modo sandbox puede saltarse la verificación.
    if (!paypal.isConfigured()) {
      if (!isSandbox) {
        console.error("[zendit] PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET no configurados: compra rechazada");
        return json(503, { error: "payment_verification_unavailable" });
      }
    } else {
      const orderId = (event.headers["x-paypal-order-id"] || event.headers["X-PayPal-Order-Id"] || "").trim();
      let unitCost = null;
      if (kind === "esim") {
        const raw = Object.prototype.hasOwnProperty.call(TIER2, offerId) ? TIER2[offerId] : null;
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
        "Content-Length": forwardBody ? Buffer.byteLength(forwardBody) : 0,
      },
      forwardBody
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

    if (method === "GET" && pathOnly.startsWith("/esim/offers")) stripEsimCosts(data);

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
