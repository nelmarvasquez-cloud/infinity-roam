// ============================================================
//  CATALOG.JS — Búsqueda por país y región
// ============================================================

let allOffers = [];
let filteredOffers = [];
let searchQuery = "";
let onlyUnlimited = false;
let catalogLoaded = false;

// Normaliza aliases al nombre canónico
const SEARCH_NORMALIZE = {
  // Países
  "usa":            "United States",
  "estados unidos": "United States",
  "united states":  "United States",
  "uk":             "United Kingdom",
  "reino unido":    "United Kingdom",
  "corea":          "South Korea",
  "corea del sur":  "South Korea",
  "south korea":    "South Korea",
  "emiratos":       "United Arab Emirates",
  "uae":            "United Arab Emirates",
  "emiratos arabes":"United Arab Emirates",
  "canada":         "Canada",
  "canadá":         "Canada",
  // Regiones
  "europa":              "EUROPE",
  "europe":              "EUROPE",
  "asia":                "ASIA",
  "africa":              "AFRICA",
  "áfrica":              "AFRICA",
  "latinoamerica":       "LATAM",
  "latinoamérica":       "LATAM",
  "latin america":       "LATAM",
  "latam":               "LATAM",
  "centroamerica":       "CENAM",
  "centroamérica":       "CENAM",
  "central america":     "CENAM",
  "caribe":              "CARIBBEAN",
  "caribbean":           "CARIBBEAN",
  "oriente medio":       "MIDDLE-EAST",
  "middle east":         "MIDDLE-EAST",
  "norteamerica":        "NORTH-AMERICA",
  "norteamérica":        "NORTH-AMERICA",
  "north america":       "NORTH-AMERICA",
  "oceania":             "OCEANIA",
  "oceanía":             "OCEANIA",
  "europa del este":     "EASTEURO",
  "eastern europe":      "EASTEURO",
  "global":              "GLOBAL",
  "mundial":             "GLOBAL",
};

// Region display names for search text matching
const REGION_SEARCH_ALIASES = {
  "EUROPE":        ["europe","europa","european"],
  "ASIA":          ["asia","asian"],
  "AFRICA":        ["africa","áfrica"],
  "LATAM":         ["latam","latin america","latinoamerica","latinoamérica","sudamerica","south america"],
  "CENAM":         ["cenam","central america","centroamerica","centroamérica"],
  "CARIBBEAN":     ["caribbean","caribe","antillas"],
  "MIDDLE-EAST":   ["middle east","oriente medio","meast"],
  "NORTH-AMERICA": ["north america","norteamerica","norteamérica"],
  "OCEANIA":       ["oceania","oceanía","pacific"],
  "EASTEURO":      ["eastern europe","europa del este","easteuro"],
  "GLOBAL":        ["global","mundial","worldwide","todo el mundo"],
};

function normalizeSearch(q) {
  if (!q) return "";
  const normalized = SEARCH_NORMALIZE[q.trim().toLowerCase()];
  return normalized || q.trim();
}

function getLang() {
  const saved = localStorage.getItem("ir_lang");
  if (saved === "en" || saved === "es") return saved;
  return (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
}

// ============================================================
//  HELPER FUNCTIONS — global scope (used by filterOffers,
//  renderPlanCard, showCountryBrowser, etc.)
// ============================================================
function getPlanCountry(offer) {
  if (offer.country && !offer.country.startsWith("Regional")) return offer.country;
  if (typeof getCountryFromOfferId === "function") {
    const c = getCountryFromOfferId(offer.offerId);
    if (c) return c;
  }
  return "";
}

function getPlanRegion(offer) {
  return offer.region || null;
}

function getPlanDisplayName(offer, lang) {
  if (offer.isRegional && offer.region) {
    const name = lang === "es"
      ? (offer.regionNameEs || offer.regionName || offer.region)
      : (offer.regionName || offer.region);
    return (offer.regionEmoji ? offer.regionEmoji + " " : "") + name;
  }
  const country = getPlanCountry(offer);
  if (!country) return offer.offerId;
  const nameES = (typeof COUNTRY_ES !== "undefined" && COUNTRY_ES[country]) || country;
  return lang === "es" ? nameES : country;
}

// ============================================================
//  FILTRAR Y ORDENAR
// ============================================================
function filterOffers(offers) {
  const isRegionSearch = searchQuery && Object.keys(REGION_SEARCH_ALIASES).includes(searchQuery.toUpperCase());

  const filtered = offers.filter(offer => {
    const matchUnlimited = !onlyUnlimited || offer.dataUnlimited;
    if (!matchUnlimited) return false;
    if (!searchQuery) return true;

    const sq = searchQuery.toLowerCase();
    const sqUpper = searchQuery.toUpperCase();

    // Region search: match against region slug
    if (isRegionSearch) {
      return offer.region === sqUpper ||
             (REGION_SEARCH_ALIASES[sqUpper] || []).some(a => a === sq);
    }

    // Country search
    const country   = getPlanCountry(offer);
    const countryES = (typeof COUNTRY_ES !== "undefined" && COUNTRY_ES[country]) || country;
    const COUNTRY_ALIASES = {
      "united states": "usa estados unidos",
      "usa":           "united states estados unidos",
      "estados unidos":"usa united states",
      "uk":            "united kingdom reino unido",
      "reino unido":   "united kingdom uk",
      "south korea":   "corea corea del sur korea",
      "united arab emirates": "uae emiratos dubai",
    };
    const searchText = [
      country.toLowerCase(),
      countryES.toLowerCase(),
      COUNTRY_ALIASES[country.toLowerCase()] || "",
      COUNTRY_ALIASES[countryES.toLowerCase()] || "",
      (offer.regionName || "").toLowerCase(),
      (offer.regionNameEs || "").toLowerCase(),
      (offer.offerId || "").toLowerCase(),
    ].join(" ");

    return searchText.includes(sq);
  });

  // ── DEDUPLICACIÓN ────────────────────────────────────────
  // Country plans: same country+data+days → cheapest wins
  // Regional plans: same region+data+days → cheapest wins
  // Both: ULP/ULE/UNLIMITED same base → cheapest (most competitive price)
  const seen = new Map();
  for (const offer of filtered) {
    const groupKey = offer.isRegional
      ? offer.region || "unknown"
      : getPlanCountry(offer);
    const days  = offer.durationDays || 0;
    const price = getOfferPrice(offer);
    const key   = offer.dataUnlimited
      ? `${groupKey}|unlimited|${days}`
      : `${groupKey}|${offer.dataGB || 0}gb|${days}`;
    if (!seen.has(key) || price < seen.get(key).price) {
      seen.set(key, { offer, price });
    }
  }
  const deduped = [...seen.values()].map(v => v.offer);

  // ── FILTRO COMERCIAL ─────────────────────────────────────
  // Hide GB plans that cost more than an unlimited for same group+days
  const unlimitedByKey = new Map();
  for (const offer of deduped) {
    if (offer.dataUnlimited) {
      const groupKey = offer.isRegional ? offer.region : getPlanCountry(offer);
      const key = `${groupKey}|${offer.durationDays || 0}`;
      const price = getOfferPrice(offer);
      if (!unlimitedByKey.has(key) || price < unlimitedByKey.get(key))
        unlimitedByKey.set(key, price);
    }
  }
  const commercial = deduped.filter(offer => {
    if (offer.dataUnlimited) return true;
    const groupKey = offer.isRegional ? offer.region : getPlanCountry(offer);
    const key = `${groupKey}|${offer.durationDays || 0}`;
    const unlimitedPrice = unlimitedByKey.get(key);
    return unlimitedPrice === undefined || getOfferPrice(offer) <= unlimitedPrice;
  });

  // Ordenar: por país → limitados primero (precio asc) → ilimitados (precio asc)
  commercial.sort((a, b) => {
    const ca = getPlanCountry(a);
    const cb = getPlanCountry(b);
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    if (!a.dataUnlimited && b.dataUnlimited) return -1;
    if (a.dataUnlimited && !b.dataUnlimited) return 1;
    return getOfferPrice(a) - getOfferPrice(b);
  });

  return commercial;
}

function getOfferPrice(offer) {
  if (typeof getPlanPrice === "function") return parseFloat(getPlanPrice(offer)) || 0;
  const c = offer.cost || {};
  const fixed = Number(c.fixed) || 0;
  const div = Number(c.currencyDivisor) || 100;
  return fixed > 0 ? (fixed / div) * (CONFIG?.MARKUP || 1.5) : 0;
}

// ============================================================
//  CARGAR CATÁLOGO
// ============================================================
async function loadCatalog() {
  const loading = document.getElementById("catalog-loading");
  const error = document.getElementById("catalog-error");
  const browser = document.getElementById("country-browser");

  loading.style.display = "grid";
  error.style.display = "none";
  browser.style.display = "none";

  try {
    const resp = await fetch("/.netlify/functions/catalog");
    if (!resp.ok) throw new Error(`Error ${resp.status}`);
    const data = await resp.json();
    allOffers = data.list || [];
    catalogLoaded = true;

    loading.style.display = "none";

    console.log(`[Catalog] ${allOffers.length} planes cargados`);

    // Mostrar browser de países si no hay búsqueda activa
    if (!searchQuery) {
      showCountryBrowser();
    } else {
      filteredOffers = filterOffers(allOffers);
      renderCatalog(filteredOffers);
    }

  } catch (err) {
    loading.style.display = "none";
    error.style.display = "flex";
    document.getElementById("error-msg").textContent = "Error cargando planes: " + err.message;
  }
}

// ============================================================
//  BROWSER DE PAÍSES POPULARES — Estado inicial
// ============================================================
function showCountryBrowser() {
  const lang = getLang();
  const browser = document.getElementById("country-browser");
  const chipsEl = document.getElementById("country-chips");
  const grid = document.getElementById("catalog-grid");
  const hint = document.getElementById("browser-hint");

  grid.style.display = "none";
  browser.style.display = "block";

  hint.textContent = lang === "es" ? "🌍 Destinos populares — toca para explorar" : "🌍 Popular destinations — tap to explore";

  // Obtener países únicos con conteo de planes
  const countryCounts = {};
  for (const offer of allOffers) {
    const c = getPlanCountry(offer);
    if (c) countryCounts[c] = (countryCounts[c] || 0) + 1;
  }

  // Países prioritarios + resto alfabético
  const PRIORITY = [
    "United States", "Spain", "Mexico", "Canada", "France", "Italy", "Germany",
    "United Kingdom", "Japan", "Thailand", "Colombia", "Brazil",
    "Panama", "Australia", "Singapore", "United Arab Emirates", "India",
    "Argentina", "Portugal", "Netherlands", "South Korea"
  ];

  // Mostrar solo destinos populares estáticos — sin conteos, sin clicks
  const POPULAR = [
    { country: "United States", flag: "🇺🇸" },
    { country: "Spain",         flag: "🇪🇸" },
    { country: "France",        flag: "🇫🇷" },
    { country: "Italy",         flag: "🇮🇹" },
    { country: "Germany",       flag: "🇩🇪" },
    { country: "United Kingdom",flag: "🇬🇧" },
    { country: "Mexico",        flag: "🇲🇽" },
    { country: "Canada",        flag: "🇨🇦" },
    { country: "Japan",         flag: "🇯🇵" },
    { country: "Thailand",      flag: "🇹🇭" },
    { country: "Australia",     flag: "🇦🇺" },
    { country: "Singapore",     flag: "🇸🇬" },
  ];

  chipsEl.innerHTML = POPULAR.map(({ country, flag }) => {
    const nameES = (typeof COUNTRY_ES !== "undefined" && COUNTRY_ES[country]) || country;
    const displayName = lang === "es" ? nameES : country;
    return `<span class="country-chip">
      <span class="country-chip-flag">${flag}</span>
      <span class="country-chip-name">${displayName}</span>
    </span>`;
  }).join("");

  renderPopularPlansGrid(POPULAR);
}

// ============================================================
//  PLANES POPULARES (contenido real, visible sin necesidad de
//  buscar — evita que la página se vea "vacía" para Google y
//  para cualquier visitante que aún no escribió nada).
// ============================================================
function renderPopularPlansGrid(popularList) {
  const grid = document.getElementById("popular-plans-grid");
  if (!grid || !allOffers.length) return;

  const picks = [];
  for (const { country } of popularList) {
    const candidates = allOffers.filter(o => getPlanCountry(o) === country && !o.isRegional);
    if (!candidates.length) continue;
    const cheapest = candidates.reduce((a, b) => (getOfferPrice(a) <= getOfferPrice(b) ? a : b));
    picks.push(cheapest);
  }

  grid.innerHTML = picks.map(renderPlanCard).join("");
  attachBuyButtons();
}

// ============================================================
//  RENDERIZAR CATÁLOGO
// ============================================================
function renderCatalog(offers) {
  const grid = document.getElementById("catalog-grid");
  const noResults = document.getElementById("no-results");
  const counter = document.getElementById("results-counter");
  const lang = getLang();

  // TRACKING: view_destination — se dispara cuando hay una búsqueda activa
  // y muestra resultados reales (no en la vista por defecto de "populares").
  // Usa "usuarios viendo un destino", distinto de view_item (planes individuales).
  if (searchQuery && offers.length > 0 && typeof gtag === "function") {
    gtag("event", "view_destination", {
      destination: searchQuery,
      results_count: offers.length,
    });
    window.debugAnalytics && window.debugAnalytics("GA4", "view_destination", { destination: searchQuery, count: offers.length });
  }

  if (counter) {
    if (offers.length > 0) {
      counter.textContent = lang === "es"
        ? `${offers.length} planes encontrados`
        : `${offers.length} plans found`;
      counter.style.display = "inline";
    } else {
      counter.style.display = "none";
    }
  }

  if (!offers.length) {
    grid.style.display = "none";
    noResults.style.display = "block";
    return;
  }

  noResults.style.display = "none";
  grid.style.display = "grid";

  // ── VISTA CURADA POR DEFECTO ──────────────────────────────
  // Cuando una búsqueda de país/región devuelve muchos planes (choice
  // overload — un país "normal" puede tener 20-30 después del filtro
  // comercial), se muestran solo los primeros por defecto, con un
  // botón para ver el resto. Los offers YA vienen ordenados (limitados
  // barato→caro, luego ilimitados barato→caro), así que "los primeros"
  // ya son una selección razonable sin necesitar un algoritmo nuevo.
  // No aplica a la vista de "países populares" (esa no llega aquí con
  // searchQuery activo) ni cuando hay pocos resultados.
  const CURATED_LIMIT = 8;
  const shouldCurate = !!searchQuery && offers.length > CURATED_LIMIT;
  const visibleOffers = shouldCurate ? offers.slice(0, CURATED_LIMIT) : offers;

  grid.innerHTML = visibleOffers.map(renderPlanCard).join("");

  const existingBtn = document.getElementById("show-all-plans-btn");
  if (existingBtn) existingBtn.remove();

  if (shouldCurate) {
    const remaining = offers.length - CURATED_LIMIT;
    const btnWrap = document.createElement("div");
    btnWrap.id = "show-all-plans-btn";
    btnWrap.style.cssText = "grid-column:1/-1;text-align:center;margin-top:8px";
    btnWrap.innerHTML = `
      <button style="padding:12px 28px;border-radius:99px;cursor:pointer;font-size:0.9rem;font-weight:600;background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.25);font-family:inherit;transition:background .2s" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='transparent'" id="show-all-plans-inner-btn">
        ${lang === "es" ? `Ver todos los planes (${remaining} más)` : `See all plans (${remaining} more)`}
      </button>`;
    grid.after(btnWrap);
    document.getElementById("show-all-plans-inner-btn").addEventListener("click", () => {
      grid.innerHTML = offers.map(renderPlanCard).join("");
      attachBuyButtons();
      btnWrap.remove();
      if (typeof gtag === "function") gtag("event", "view_all_plans_clicked", { destination: searchQuery, total_plans: offers.length });
    });
  }

  attachBuyButtons();
}

// ============================================================
//  TARJETA DE PLAN
// ============================================================
function renderPlanCard(offer) {
  const lang = getLang();
  const price = typeof getPlanPrice === "function" ? getPlanPrice(offer) : "0.00";

  // Country or region display
  let flag, countryDisplay, regionBadge = "";
  if (offer.isRegional && offer.region) {
    flag = offer.regionEmoji || "🌍";
    countryDisplay = lang === "es"
      ? (offer.regionNameEs || offer.regionName || offer.region)
      : (offer.regionName || offer.region);
    regionBadge = `<span style="display:inline-block;margin-top:4px;background:rgba(40,100,230,0.15);color:#2864E6;border:1px solid rgba(40,100,230,0.3);border-radius:6px;padding:1px 7px;font-size:0.68rem;font-weight:700;letter-spacing:.05em">${lang === "es" ? "PLAN REGIONAL" : "REGIONAL PLAN"}</span>`;
  } else {
    const country = getPlanCountry(offer);
    countryDisplay = lang === "es"
      ? ((typeof COUNTRY_ES !== "undefined" && COUNTRY_ES[country]) || country)
      : country;
    const code = Object.entries(COUNTRY_CODE || {}).find(([k, v]) => v === country)?.[0];
    flag = code && COUNTRY_FLAG ? (COUNTRY_FLAG[code] || "🌍") : "🌍";
  }

  // Datos
  const dataText = offer.dataUnlimited
    ? (lang === "es" ? "Ilimitado" : "Unlimited")
    : (offer.dataGB > 0 ? `${offer.dataGB} GB` : (lang === "es" ? "Datos incluidos" : "Data included"));

  // Días
  const daysText = offer.durationDays > 0
    ? `${offer.durationDays} ${lang === "es" ? "días" : "days"}`
    : "";

  // Nombre del plan
  const name = typeof getPlanName === "function" ? getPlanName(offer, lang) : "eSIM";

  // Badge de velocidad
  const speedBadge = typeof getSpeedBadge === "function" ? getSpeedBadge(offer, lang) : "";

  // Descripción de velocidad
  const speedDesc = offer.dataUnlimited && typeof getSpeedDesc === "function"
    ? `<p class="speed-desc">${getSpeedDesc(offer, lang)}</p>` : "";

  const buyText = lang === "es" ? "Comprar →" : "Buy →";

  // China-specific: badge de "desbloqueado" y advertencia de instalación
  // RETIRADOS a propósito (pendiente confirmar con Zendit si el enrutamiento
  // real de esta oferta es internacional — de eso depende si la promesa de
  // "WhatsApp/Google/Instagram desbloqueados" es cierta o no). No borrar
  // isChinaPlan: sigue siendo necesario para identificar estas ofertas si
  // se quiere mostrar algo distinto en el futuro (envío gratis, badge de
  // "requiere confirmación", etc.), una vez se tenga la respuesta de Zendit.
  const isChinaPlan = offer.offerId && offer.offerId.includes("-CN-");
  const chinaBadge = "";
  const chinaWarning = "";
  let coverageSection = "";
  if (offer.isRegional && offer.coverageCountries && offer.coverageCountries.length) {
    const countries = offer.coverageCountries;
    const preview = countries.slice(0, 5).join(", ");
    const remaining = countries.length - 5;
    const showMore  = lang === "es" ? `+${remaining} más` : `+${remaining} more`;
    const showLabel = lang === "es" ? "Ver todos" : "See all";
    const hideLabel = lang === "es" ? "Ver menos" : "See less";
    const covLabel  = lang === "es" ? "Países con cobertura" : "Countries covered";
    const cardId    = offer.offerId.replace(/[^a-zA-Z0-9]/g, "_");

    coverageSection = `
      <div class="plan-coverage" style="margin:8px 0 4px;padding:8px 10px;background:rgba(40,100,230,0.07);border:1px solid rgba(40,100,230,0.15);border-radius:10px;font-size:0.75rem;">
        <div style="color:#2864E6;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px">
          🌍 ${covLabel} (${countries.length})
        </div>
        <div id="cov-preview-${cardId}" style="color:#B0B0B0;line-height:1.5">
          ${preview}${remaining > 0 ? ` <button onclick="toggleCoverage('${cardId}')" style="background:none;border:none;color:#2864E6;cursor:pointer;font-size:0.75rem;padding:0;font-family:inherit">${showMore}</button>` : ""}
        </div>
        ${remaining > 0 ? `<div id="cov-full-${cardId}" style="display:none;color:#B0B0B0;line-height:1.6">
          ${countries.join(", ")} <button onclick="toggleCoverage('${cardId}')" style="background:none;border:none;color:#2864E6;cursor:pointer;font-size:0.75rem;padding:0;font-family:inherit">${hideLabel}</button>
        </div>` : ""}
      </div>`;
  }

  return `
    <div class="plan-card">
      <div class="plan-card-header">
        <span class="plan-flag">${flag}</span>
        <div>
          <span class="plan-country-name">${countryDisplay}</span>
          ${regionBadge}
          ${chinaBadge}
          ${speedBadge ? `<span style="margin-top:3px;display:block;">${speedBadge}</span>` : ""}
        </div>
      </div>
      ${speedDesc}
      <div class="plan-highlights">
        <div class="plan-highlight">
          <span class="highlight-value">${dataText}</span>
          <span class="highlight-label">${lang === "es" ? "Datos" : "Data"}</span>
        </div>
        ${daysText ? `<div class="plan-highlight">
          <span class="highlight-value">${daysText}</span>
          <span class="highlight-label">${lang === "es" ? "Duración" : "Duration"}</span>
        </div>` : ""}
      </div>
      <div class="plan-features">
        <div class="plan-feature"><span class="feature-icon">⚡</span><span>${lang === "es" ? "Activacion instantanea" : "Instant activation"}</span></div>
        <div class="plan-feature"><span class="feature-icon">📧</span><span>${lang === "es" ? "QR por email" : "QR by email"}</span></div>
      </div>
      ${chinaWarning}
      ${coverageSection}
      <div class="plan-qty-row">
        <span class="plan-qty-label">${lang === "es" ? "Cantidad" : "Quantity"}</span>
        <div class="plan-qty-stepper" data-offer-id="${offer.offerId}">
          <button type="button" class="qty-btn qty-minus" aria-label="-">−</button>
          <span class="qty-value">1</span>
          <button type="button" class="qty-btn qty-plus" aria-label="+">+</button>
        </div>
      </div>
      <div class="plan-footer">
        <div class="plan-price">
          <span class="price-amount" data-unit-price="${price}">${formatPrice(price)}</span>
          <span class="price-label">USD</span>
        </div>
        <button class="btn-buy"
          data-offer-id="${offer.offerId}"
          data-price="${price}"
          data-name="${encodeURIComponent(name)}"
          data-destination="${encodeURIComponent(countryDisplay)}"
          data-plan-type="${offer.isRegional ? "regional" : "country"}"
          data-duration="${offer.durationDays || 0}"
          data-data-amount="${offer.dataUnlimited ? "unlimited" : (offer.dataGB || 0) + "GB"}">
          ${buyText}
        </button>
      </div>
    </div>`;
}

function attachBuyButtons() {
  const MAX_QTY = 5;

  // Steppers de cantidad — uno por tarjeta, independiente del resto
  document.querySelectorAll(".plan-qty-stepper").forEach((stepper) => {
    const valueEl = stepper.querySelector(".qty-value");
    const minusBtn = stepper.querySelector(".qty-minus");
    const plusBtn = stepper.querySelector(".qty-plus");
    const updateButtons = () => {
      const qty = parseInt(valueEl.textContent, 10) || 1;
      minusBtn.disabled = qty <= 1;
      plusBtn.disabled = qty >= MAX_QTY;
    };
    minusBtn.addEventListener("click", () => {
      const qty = Math.max(1, (parseInt(valueEl.textContent, 10) || 1) - 1);
      valueEl.textContent = qty;
      updateButtons();
    });
    plusBtn.addEventListener("click", () => {
      const qty = Math.min(MAX_QTY, (parseInt(valueEl.textContent, 10) || 1) + 1);
      valueEl.textContent = qty;
      updateButtons();
    });
    updateButtons();
  });

  document.querySelectorAll(".btn-buy").forEach(btn => {
    btn.addEventListener("click", () => {
      const price = parseFloat(btn.dataset.price) || 0;
      const name = decodeURIComponent(btn.dataset.name || "");
      const destination = decodeURIComponent(btn.dataset.destination || "");
      const planType = btn.dataset.planType || "";
      const duration = parseInt(btn.dataset.duration, 10) || 0;
      const dataAmount = btn.dataset.dataAmount || "";
      const utms = (typeof getStoredUTMs === "function") ? getStoredUTMs() : {};
      const eventId = (typeof generateEventId === "function") ? generateEventId("add_to_cart") : "";

      // Cantidad seleccionada en el stepper de ESTA tarjeta (1 por defecto,
      // máx. 5). Si por algún motivo no se encuentra el stepper, cae a 1 —
      // el flujo de compra de una sola unidad sigue funcionando igual.
      const stepperEl = document.querySelector(`.plan-qty-stepper[data-offer-id="${btn.dataset.offerId}"]`);
      const quantity = Math.min(MAX_QTY, Math.max(1, parseInt(stepperEl?.querySelector(".qty-value")?.textContent, 10) || 1));

      // TRACKING: select_plan — "el usuario eligió este plan específico entre
      // los mostrados". Evento propio del catálogo, no un estándar de GA4,
      // pensado para el análisis por destino/plan (sección 6 del embudo).
      if (typeof gtag === "function") {
        gtag("event", "select_plan", {
          item_id: btn.dataset.offerId,
          item_name: name,
          destination: destination,
          plan_type: planType,
          duration: duration,
          data_amount: dataAmount,
          price: price,
          quantity: quantity,
        });
        window.debugAnalytics && window.debugAnalytics("GA4", "select_plan", { offerId: btn.dataset.offerId, destination });
      }

      // GA4 ecommerce event: add_to_cart
      if (typeof gtag === "function") {
        gtag("event", "add_to_cart", {
          currency: "USD",
          value: price * quantity,
          destination: destination,
          plan_type: planType,
          duration: duration,
          data_amount: dataAmount,
          items: [{
            item_id: btn.dataset.offerId,
            item_name: name,
            price: price,
            quantity: quantity
          }],
          utm_source: utms.utm_source, utm_medium: utms.utm_medium,
          utm_campaign: utms.utm_campaign, utm_content: utms.utm_content,
        });
      }
      // Meta Pixel: AddToCart (mismo event_id que la llamada server-side de abajo)
      if (typeof fbq === "function") {
        fbq("track", "AddToCart", {
          content_ids: [btn.dataset.offerId], content_name: name,
          value: price * quantity, currency: "USD",
        }, { eventID: eventId });
      }
      // Meta Conversions API (server-side, mismo event_id => Meta deduplica)
      if (typeof sendToCAPI === "function") {
        sendToCAPI("AddToCart", eventId, {
          content_ids: [btn.dataset.offerId], content_name: name,
          value: price * quantity, currency: "USD",
        });
      }
      window.debugAnalytics && window.debugAnalytics("GA4+Meta", "add_to_cart / AddToCart", { offerId: btn.dataset.offerId, price, quantity });

      window.location.href = `checkout.html?offerId=${btn.dataset.offerId}&price=${btn.dataset.price}&name=${btn.dataset.name}&destination=${btn.dataset.destination}&planType=${btn.dataset.planType}&duration=${btn.dataset.duration}&dataAmount=${btn.dataset.dataAmount}&quantity=${quantity}`;
    });
  });
}

// Toggle full country list on regional plan cards
function toggleCoverage(cardId) {
  const preview = document.getElementById(`cov-preview-${cardId}`);
  const full    = document.getElementById(`cov-full-${cardId}`);
  if (!preview || !full) return;
  const isExpanded = full.style.display !== "none";
  preview.style.display = isExpanded ? "block" : "none";
  full.style.display    = isExpanded ? "none"  : "block";
  // TRACKING: view_coverage — solo al expandir la lista completa de países
  if (!isExpanded && typeof gtag === "function") {
    gtag("event", "view_coverage", { item_id: cardId });
    window.debugAnalytics && window.debugAnalytics("GA4", "view_coverage", { item_id: cardId });
  }
}

// ============================================================
//  BUSCADOR CON SUGERENCIAS
// ============================================================
function initSearch() {
  const input = document.getElementById("search-input");
  const clearBtn = document.getElementById("clear-search");
  const wrap = document.getElementById("search-box-wrap");
  const browser = document.getElementById("country-browser");
  const grid = document.getElementById("catalog-grid");

  if (!input) return;

  // Sugerencias dropdown
  const suggestBox = document.createElement("div");
  suggestBox.id = "search-suggestions";
  suggestBox.style.cssText = `
    position:absolute;left:0;right:0;top:calc(100% + 6px);
    background:white;border-radius:14px;
    box-shadow:0 8px 32px rgba(0,0,0,0.12);
    z-index:200;display:none;max-height:280px;overflow-y:auto;
    border:1px solid var(--border);
  `;
  wrap.style.position = "relative";
  wrap.appendChild(suggestBox);

  function getCountryList() {
    if (!allOffers.length) return [];
    const lang = getLang();
    const seen = new Set();
    const list = [];
    for (const offer of allOffers) {
      const c = getPlanCountry(offer);
      if (!c || seen.has(c)) continue;
      seen.add(c);
      const nameES = (typeof COUNTRY_ES !== "undefined" && COUNTRY_ES[c]) || c;
      list.push({ en: c, es: nameES });
    }
    return list.sort((a, b) => (lang === "es" ? a.es : a.en).localeCompare(lang === "es" ? b.es : b.en));
  }

  function showSuggestions(query) {
    const lang = getLang();
    const all = getCountryList();
    // Aliases so "USA", "Estados Unidos" etc. find "United States"
    const SUGGESTION_ALIASES = {
      "usa": "united states", "estados unidos": "united states",
      "uk": "united kingdom", "reino unido": "united kingdom",
      "corea": "south korea", "corea del sur": "south korea",
      "emiratos": "united arab emirates", "uae": "united arab emirates",
    };
    const normalizedQuery = SUGGESTION_ALIASES[query.toLowerCase()] || query;
    const matches = query
      ? all.filter(c =>
          c.en.toLowerCase().includes(query.toLowerCase()) ||
          c.es.toLowerCase().includes(query.toLowerCase()) ||
          c.en.toLowerCase().includes(normalizedQuery.toLowerCase()) ||
          c.es.toLowerCase().includes(normalizedQuery.toLowerCase())
        ).slice(0, 8)
      : all.slice(0, 10);

    if (!matches.length) { suggestBox.style.display = "none"; return; }

    suggestBox.innerHTML = matches.map(c => {
      const code = Object.entries(COUNTRY_CODE || {}).find(([k, v]) => v === c.en)?.[0];
      const flagEmoji = code && COUNTRY_FLAG ? (COUNTRY_FLAG[code] || "🌍") : "🌍";
      const displayName = lang === "es" ? c.es : c.en;
      return `<div class="suggestion-item" data-en="${c.en}" data-display="${displayName}"
        style="padding:10px 16px;cursor:pointer;font-size:0.88rem;display:flex;align-items:center;gap:10px;transition:background 0.15s;">
        <span style="font-size:1.2rem;">${flagEmoji}</span>
        <span>${displayName}</span>
      </div>`;
    }).join("");

    suggestBox.querySelectorAll(".suggestion-item").forEach(item => {
      item.addEventListener("mouseenter", () => item.style.background = "#f5f5f5");
      item.addEventListener("mouseleave", () => item.style.background = "");
      item.addEventListener("click", () => {
        input.value = item.dataset.display;
        searchQuery = normalizeSearch(item.dataset.en);
        clearBtn.style.display = "block";
        suggestBox.style.display = "none";
        browser.style.display = "none";
        filteredOffers = filterOffers(allOffers);
        renderCatalog(filteredOffers);
      });
    });

    suggestBox.style.display = "block";
  }

  input.addEventListener("focus", () => {
    if (!searchQuery) showSuggestions("");
  });

  let _searchDebounceTimer = null;
  input.addEventListener("input", e => {
    const q = e.target.value.trim();
    searchQuery = normalizeSearch(q);

    // TRACKING: search_destination (debounced 800ms — evita spamear el evento
    // en cada tecla). Solo dato de comportamiento, sin PII.
    clearTimeout(_searchDebounceTimer);
    if (q) {
      _searchDebounceTimer = setTimeout(() => {
        const resultsCount = catalogLoaded ? filterOffers(allOffers).length : 0;
        if (typeof gtag === "function") {
          gtag("event", "search_destination", { search_term: searchQuery, results_count: resultsCount });
        }
        window.debugAnalytics && window.debugAnalytics("GA4", "search_destination", { search_term: searchQuery, results_count: resultsCount });
      }, 800);
    }

    if (!q) {
      suggestBox.style.display = "none";
      grid.style.display = "none";
      if (catalogLoaded) showCountryBrowser();
      return;
    }

    showSuggestions(q);
    if (catalogLoaded) {
      filteredOffers = filterOffers(allOffers);
      browser.style.display = "none";
      renderCatalog(filteredOffers);
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    searchQuery = "";
    clearBtn.style.display = "none";
    suggestBox.style.display = "none";
    grid.style.display = "none";
    document.getElementById("no-results").style.display = "none";
    document.getElementById("results-counter").style.display = "none";
    if (catalogLoaded) showCountryBrowser();
    input.focus();
  });

  document.addEventListener("click", e => {
    if (!wrap.contains(e.target)) suggestBox.style.display = "none";
  });
}

// ============================================================
//  BOTÓN SOLO ILIMITADOS
// ============================================================
function initUnlimitedToggle() {
  const btn = document.getElementById("unlimited-toggle");
  const label = document.getElementById("unlimited-label");
  if (!btn) return;

  btn.addEventListener("click", () => {
    onlyUnlimited = !onlyUnlimited;
    btn.classList.toggle("active", onlyUnlimited);
    const lang = getLang();
    if (label) label.textContent = lang === "es" ? "Solo Ilimitados" : "Unlimited Only";

    if (searchQuery || onlyUnlimited) {
      filteredOffers = filterOffers(allOffers);
      document.getElementById("country-browser").style.display = "none";
      renderCatalog(filteredOffers);
    } else if (catalogLoaded) {
      showCountryBrowser();
    }
  });
}

// ============================================================
//  INIT
// ============================================================
window.addEventListener("DOMContentLoaded", () => {
  // Parámetro ?search= desde el homepage
  const urlParams = new URLSearchParams(window.location.search);
  const searchParam = urlParams.get("search");
  if (searchParam) {
    const input = document.getElementById("search-input");
    if (input) input.value = decodeURIComponent(searchParam);
    searchQuery = normalizeSearch(decodeURIComponent(searchParam));
    document.getElementById("clear-search").style.display = "block";
  }

  initSearch();
  initUnlimitedToggle();
  loadCatalog();
});

window.addEventListener("ir_lang_changed", () => {
  const lang = getLang();
  const label = document.getElementById("unlimited-label");
  if (label) label.textContent = lang === "es" ? "Solo Ilimitados" : "Unlimited Only";

  if (catalogLoaded) {
    if (searchQuery) {
      filteredOffers = filterOffers(allOffers);
      renderCatalog(filteredOffers);
    } else {
      showCountryBrowser();
    }
  }
});
