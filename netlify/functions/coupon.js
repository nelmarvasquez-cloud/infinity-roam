// ============================================================
//  COUPON.JS — Validación server-side de cupones con
//  restricciones que el cliente NO puede verificar de forma
//  confiable (país del comprador, ventana de fechas).
//
//  TODOS los cupones viven aquí, en el servidor, para que la lista de
//  códigos NO sea visible en el JavaScript público del navegador
//  (checkout.js es un archivo público que cualquiera puede leer).
//  Los que no tienen allowedCountryCode / validFrom / validUntil
//  simplemente no tienen esa restricción.
//
//  DETECCIÓN DE PAÍS — confirmado con prueba real y diagnóstico:
//  `context.geo` (la forma "oficial" documentada por Netlify) NO
//  llega en el modo de función que usa este proyecto
//  (exports.handler — modo "Lambda compatibility", deprecado a
//  partir del 1 de julio de 2027; no urgente todavía).
//  En su lugar, Netlify SÍ envía la geolocalización como HEADERS
//  nativos en este modo — descubierto inspeccionando los headers
//  reales de una petición: `x-country` (código de país directo) y
//  `x-nf-geo` (el mismo objeto geo, codificado en base64). Se usan
//  esos headers como fuente principal. ipapi.co (servicio externo)
//  queda solo como último recurso, ya que se confirmó que falla
//  por límite de uso compartido entre clientes de Netlify (error
//  429 "RateLimited" — no es específico de este sitio).
//  Fail-closed: si ninguna fuente logra determinar el país, el
//  cupón se rechaza — nunca se aplica "por si acaso".
// ============================================================

const { corsHeaders, originAllowed, requestOrigin, rateLimited, clientIp: ipOf } = require("./lib/security");
const pricing = require("./lib/pricing");

const GEO_COUPONS = {
  // Precio = breakeven + 50% del profit del precio sugerido Zendit
  "INFINITYDEAL": {
    type: "pioneer_tier2",
    paypalFee: 0.11,
    profitShare: 0.5,
    description: "Precio especial Infinity Deal",
  },
  "REMAXINFINITY": {
    type: "breakeven_tier2",
    paypalFee: 0.11,
    description: "Precio especial REMAX Infinity",
  },
  // Descuentos planos (el piso de precio anti-pérdida lo aplica checkout.js)
  "REMAXHOGAR": {
    type: "percent",
    discount: 5,
    description: "5% de descuento — REMAX Hogar",
  },
  "HONORINFINITY": {
    type: "percent",
    discount: 10,
    description: "10% de descuento — Honor Infinity",
  },
  "PATRIAS": {
    type: "pioneer_tier2",
    paypalFee: 0.11,
    profitShare: 0.25, // más agresivo que INFINITYDEAL (0.5) = más descuento
    description: "Precio especial Panamá — Fiestas Patrias 2026",
    allowedCountryCode: "PA", // ISO 3166-1 alpha-2 para Panamá
    validFrom: "2026-08-01T00:00:00Z",
    validUntil: "2026-11-30T23:59:59Z",
  },
};

const baseHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

exports.handler = async function (event, context) {
  const headers = { ...baseHeaders, ...corsHeaders(event) };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Solo desde nuestro sitio (y Deploy Previews)
  if (!originAllowed(requestOrigin(event))) {
    return { statusCode: 403, headers, body: JSON.stringify({ valid: false, reason: "forbidden" }) };
  }

  // Anti fuerza bruta: nadie debería poder probar códigos en serie.
  // 8 intentos por minuto y 40 por hora por IP (en memoria, por instancia).
  const ip = ipOf(event);
  if (rateLimited("coupon-min:" + ip, 8, 60 * 1000) || rateLimited("coupon-hour:" + ip, 40, 60 * 60 * 1000)) {
    return { statusCode: 429, headers, body: JSON.stringify({ valid: false, reason: "rate_limited", message: "Demasiados intentos. Espera un minuto e inténtalo de nuevo." }) };
  }

  let code, reqBody;
  const debug = false; // el modo de diagnóstico por parámetro ya no existe (filtraba datos internos)
  try {
    reqBody = JSON.parse(event.body || "{}");
    code = reqBody.code;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ valid: false, reason: "Solicitud inválida" }) };
  }
  // El navegador manda el plan (offerId + precio de lista) y recibe SOLO el precio final:
  // los parámetros del cupón (comisión, % de ganancia, descuento) y los costos nunca salen del servidor.
  const quote = pricing.parseQuote(reqBody);

  const diag = {}; // diagnóstico crudo — solo se devuelve si debug=true

  const cleanCode = String(code || "").toUpperCase().trim().slice(0, 40);
  const coupon = GEO_COUPONS[cleanCode];

  if (!coupon) {
    return { statusCode: 200, headers, body: JSON.stringify({ valid: false, reason: "not_found" }) };
  }

  // ── 1. Ventana de fechas (confiable: se calcula en el servidor,
  //    el reloj del navegador del comprador no se usa para esto) ──
  const now = new Date();
  const from = coupon.validFrom ? new Date(coupon.validFrom) : null;
  const until = coupon.validUntil ? new Date(coupon.validUntil) : null;
  if ((from && now < from) || (until && now > until)) {
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ valid: false, reason: "expired", validFrom: coupon.validFrom, validUntil: coupon.validUntil }),
    };
  }

  // Respuesta de cupón válido: solo descripción y precio final por unidad.
  const validResponse = (extra = {}) => {
    if (!quote) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, reason: "bad_request" }) };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        description: coupon.description,
        finalPrice: pricing.couponPrice(quote.listPrice, coupon, quote.offerId),
        ...extra,
      }),
    };
  };

  // Cupones sin restricción de país: válidos de inmediato.
  if (!coupon.allowedCountryCode) {
    return validResponse();
  }

  // ── 2. País del visitante ──
  // DESCUBIERTO con diagnóstico real: Netlify SÍ envía la geolocalización
  // para este tipo de función, pero como HEADERS nativos — no vía
  // `context.geo` (que resultó vacío) ni requiere un servicio externo.
  // Prioridad: x-country (directo) > x-nf-geo (JSON en base64) >
  // ipapi.co (último recurso, puede fallar por límite de uso compartido
  // entre clientes de Netlify — ya lo confirmamos con una prueba real).
  let detectedCountry = null;
  diag.context_geo_raw = context?.geo || null;

  const xCountryHeader = event.headers["x-country"];
  if (xCountryHeader) {
    detectedCountry = xCountryHeader.toUpperCase();
    diag.detection_source = "x-country header";
  }

  if (!detectedCountry && event.headers["x-nf-geo"]) {
    try {
      const decoded = JSON.parse(Buffer.from(event.headers["x-nf-geo"], "base64").toString("utf-8"));
      diag.x_nf_geo_decoded = decoded;
      if (decoded?.country?.code) {
        detectedCountry = decoded.country.code.toUpperCase();
        diag.detection_source = "x-nf-geo header";
      }
    } catch (decodeErr) {
      diag.x_nf_geo_decode_error = decodeErr.message;
    }
  }

  const clientIp = event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || null;
  diag.headers_seen = Object.keys(event.headers || {});
  diag.client_ip_extracted = clientIp;

  // Último recurso — solo si los headers nativos de Netlify no trajeron nada
  if (!detectedCountry && clientIp) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const geoResp = await fetch(`https://ipapi.co/${clientIp}/json/`, { signal: controller.signal });
      clearTimeout(timer);
      diag.ipapi_http_status = geoResp.status;
      if (geoResp.ok) {
        const geoData = await geoResp.json();
        diag.ipapi_response = geoData;
        if (geoData && geoData.country_code && !geoData.error) {
          detectedCountry = geoData.country_code;
          diag.detection_source = "ipapi.co (fallback)";
        }
      } else {
        diag.ipapi_response = await geoResp.text().catch(() => "(no se pudo leer el cuerpo)");
      }
    } catch (geoErr) {
      diag.ipapi_error = geoErr.message;
      console.error("[coupon] Error consultando geolocalización por IP:", geoErr.message);
    }
  }

  console.log(`[coupon] ${cleanCode} solicitado — país detectado: ${detectedCountry || "NINGUNO"} | diag: ${JSON.stringify(diag)}`);

  // Fail-closed: si no se puede determinar el país con certeza, se rechaza.
  if (!detectedCountry) {
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        valid: false,
        reason: "country_undetectable",
        message: "No se pudo verificar tu ubicación. Intenta nuevamente o contacta a soporte.",
        ...(debug ? { _debug: diag } : {}),
      }),
    };
  }

  if (detectedCountry !== coupon.allowedCountryCode) {
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ valid: false, reason: "wrong_country", detected: detectedCountry, ...(debug ? { _debug: diag } : {}) }),
    };
  }

  // ── Todo válido: el precio final se calcula aquí (lib/pricing.js) ──
  return validResponse({ detected_country: detectedCountry });
};
