// ============================================================
//  ZENDIT API — Via Netlify Function
// ============================================================

const ZenditAPI = {
  async _call(path, method = "GET", bodyData = null, extraHeaders = {}) {
    const url = `/.netlify/functions/zendit?path=${encodeURIComponent(path)}`;
    const options = { method, headers: { "Content-Type": "application/json", ...extraHeaders } };
    if (bodyData) options.body = JSON.stringify(bodyData);
    const response = await fetch(url, options);
    if (!response.ok) {
      let detail = "";
      try { detail = await response.text(); } catch {}
      throw new Error(`Error ${response.status}${detail ? " — " + detail.slice(0, 300) : ""}`);
    }
    return response.json();
  },
  async getOffers(limit = 20, offset = 0) {
    return this._call(`/esim/offers?_limit=${limit}&_offset=${offset}`);
  },
  async getOffer(offerId) {
    return this._call(`/esim/offers/${offerId}`);
  },
  async purchaseESIM(offerId, transactionId, paypalOrderId) {
    // El servidor verifica con PayPal que este pedido esté pagado (Fase 1 seguridad)
    return this._call("/esim/purchases", "POST", { offerId, transactionId }, { "X-PayPal-Order-Id": paypalOrderId || "" });
  },
  async getQRCode(transactionId) {
    return this._call(`/esim/purchases/${transactionId}/qrcode`);
  },
  async getTransaction(transactionId) {
    return this._call(`/esim/purchases/${transactionId}`);
  },

  // ── MOBILE TOP-UP (envío de saldo a otro número) ──
  async getTopupOffers(params = {}) {
    const qs = new URLSearchParams({ _limit: params.limit || 50, _offset: params.offset || 0 });
    if (params.country) qs.set("country", params.country);
    if (params.brand) qs.set("brand", params.brand);
    if (params.regions) qs.set("regions", params.regions);
    if (params.subType) qs.set("subType", params.subType);
    return this._call(`/topups/offers?${qs.toString()}`);
  },
  async getTopupOffer(offerId) {
    return this._call(`/topups/offers/${offerId}`);
  },
  async purchaseTopup(offerId, recipientPhoneNumber, transactionId, value, paypalOrderId) {
    const body = { offerId, recipientPhoneNumber, transactionId };
    if (value) body.value = value; // { type: "PRICE", value: <monto> } — solo para ofertas RANGE
    return this._call("/topups/purchases", "POST", body, { "X-PayPal-Order-Id": paypalOrderId || "" });
  },
  async getTopupTransaction(transactionId) {
    return this._call(`/topups/purchases/${transactionId}`);
  },
};

function generateTransactionId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `IR-${timestamp}-${random}`;
}

function applyMarkup(costPrice) {
  if (!costPrice || isNaN(costPrice) || costPrice <= 0) return "0.00";
  return (costPrice * CONFIG.MARKUP).toFixed(2);
}

function formatPrice(amount, currency = "USD") {
  return new Intl.NumberFormat("es-PA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function parseDataAmount(offer) {
  if (offer.dataUnlimited) return "Datos ilimitados";
  const gb = offer.dataGB;
  if (gb && gb > 0) return `${gb} GB`;
  return "Datos incluidos";
}

function parseDays(offer) {
  const days = offer.durationDays;
  if (days && days > 0) return `${days} días`;
  return "";
}

// Mapeo completo de regiones Zendit producción → categoría interna
function detectRegion(offer) {
  const regions = offer.regions || [];
  const text = regions.join(" ").toLowerCase();

  if (text.includes("global")) return "global";

  // Europa
  if (text.includes("western europe") || text.includes("eastern europe")) return "europe";

  // Asia (todas las variantes)
  if (text.includes("southeast asia") || text.includes("south asia") || text.includes("asia")) return "asia";

  // América (todas las variantes)
  if (
    text.includes("south america") ||
    text.includes("central america") ||
    text.includes("north america") ||
    text.includes("caribbean")
  ) return "americas";

  // Medio Oriente y África del Norte
  if (text.includes("middle east")) return "middleeast";

  // África
  if (text.includes("africa")) return "africa";

  // Oceanía
  if (text.includes("oceania")) return "oceania";

  return "other";
}

function getPlanPrice(offer) {
  const cost = offer.cost || {};
  const fixed = Number(cost.fixed) || 0;
  const divisor = Number(cost.currencyDivisor) || 100;
  if (fixed > 0) return applyMarkup(fixed / divisor);
  const min = Number(cost.min) || 0;
  if (min > 0) return applyMarkup(min / divisor);
  return "0.00";
}

function getPlanName(offer, lang) {
  // Resolver nombre del país: primero del campo country, luego del offerId
  let countryEN = offer.country || "";
  if (!countryEN || countryEN.startsWith("Regional")) {
    if (typeof getCountryFromOfferId === "function") {
      const fromId = getCountryFromOfferId(offer.offerId);
      if (fromId) countryEN = fromId;
    }
  }

  // Traducir al idioma actual
  const useLang = lang || (typeof getLang === "function" ? getLang() : "es");
  let countryName = countryEN;
  if (useLang === "es" && typeof COUNTRY_ES !== "undefined" && COUNTRY_ES[countryEN]) {
    countryName = COUNTRY_ES[countryEN];
  }

  const gb = offer.dataUnlimited
    ? (useLang === "es" ? "Ilimitado" : "Unlimited")
    : (offer.dataGB > 0 ? `${offer.dataGB}GB` : "");
  const days = offer.durationDays > 0 ? `${offer.durationDays}d` : "";
  const location = countryName && !countryName.startsWith("Regional") ? countryName : "";

  if (gb && days && location) return `eSIM — ${location} ${gb} / ${days}`;
  if (gb && days) return `eSIM — ${gb} / ${days}`;
  if (days) return `eSIM — ${days}`;
  return "eSIM";
}

// ============================================================
//  PRECIOS SUGERIDOS POR ZENDIT
//  Se carga desde zendit_prices.json al iniciar
// ============================================================
let ZENDIT_PRICE_MAP = null;

async function loadZenditPrices() {
  try {
    const resp = await fetch('/zendit_prices.json');
    ZENDIT_PRICE_MAP = await resp.json();
    console.log(`[Prices] ${Object.keys(ZENDIT_PRICE_MAP).length} precios cargados`);
  } catch (err) {
    console.warn('[Prices] No se pudo cargar precios sugeridos, usando markup:', err.message);
  }
}

// Llamar al cargar la página
loadZenditPrices();

// Override de getPlanPrice para usar precio sugerido de Zendit
function getPlanPrice(offer) {
  // Primero intentar precio sugerido de Zendit
  if (ZENDIT_PRICE_MAP && offer.offerId && ZENDIT_PRICE_MAP[offer.offerId]) {
    return ZENDIT_PRICE_MAP[offer.offerId].toFixed(2);
  }
  // Fallback al markup
  const cost = offer.cost || {};
  const fixed = Number(cost.fixed) || 0;
  const divisor = Number(cost.currencyDivisor) || 100;
  if (fixed > 0) return applyMarkup(fixed / divisor);
  const min = Number(cost.min) || 0;
  if (min > 0) return applyMarkup(min / divisor);
  return "0.00";
}
