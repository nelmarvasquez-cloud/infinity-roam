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

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event, context) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let code, debug;
  try {
    ({ code, debug } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ valid: false, reason: "Solicitud inválida" }) };
  }

  const diag = {}; // diagnóstico crudo — solo se devuelve si debug=true

  const cleanCode = (code || "").toUpperCase().trim();
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

  // Cupones sin restricción de país: válidos de inmediato.
  if (!coupon.allowedCountryCode) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        type: coupon.type,
        paypalFee: coupon.paypalFee,
        profitShare: coupon.profitShare,
        discount: coupon.discount,
        description: coupon.description,
      }),
    };
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

  // ── Todo válido: devolver los parámetros para calcular el precio
  //    (reutiliza exactamente la misma fórmula/función que ya usa
  //    INFINITYDEAL en checkout.js — calculateCouponPrice) ──
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      valid: true,
      type: coupon.type,
      paypalFee: coupon.paypalFee,
      profitShare: coupon.profitShare,
      discount: coupon.discount,
      description: coupon.description,
      detected_country: detectedCountry,
      ...(debug ? { _debug: diag } : {}),
    }),
  };
};
