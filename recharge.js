// ============================================================
//  RECHARGE.JS — Envío de saldo a otro número (Mobile Top-Up)
// ============================================================
// Reutiliza COUNTRY_CODE/COUNTRY_FLAG (countries.js) y ZenditAPI/
// applyMarkup/formatPrice (zendit.js) — pero el cálculo de precio en sí
// es propio (getTopupPrice), porque las ofertas de Top-Up usan un
// esquema de campos distinto al de eSIM (ver función más abajo).

(function () {
  const countryInput = document.getElementById("topup-country-input");
  const countrySuggestions = document.getElementById("topup-country-suggestions");
  const operatorRow = document.getElementById("topup-operator-row");
  const operatorGrid = document.getElementById("topup-operator-grid");
  const offersRow = document.getElementById("topup-offers-row");
  const offersGrid = document.getElementById("topup-offers-grid");
  const recipientCard = document.getElementById("topup-recipient-card");
  const phoneInput = document.getElementById("topup-recipient-phone");
  const emailInput = document.getElementById("topup-sender-email");
  const continueBtn = document.getElementById("topup-continue-btn");
  const errorEl = document.getElementById("topup-error");

  let allOffersForCountry = [];
  let selectedOffer = null;
  let selectedCountryCode = null;
  let selectedCountryName = null;
  let selectedBrand = null;

  // ── Cobertura de Top-Up pre-calculada ──────────────────────
  // Igual que el catálogo de eSIM (offer_country.json, etc.), la lista de
  // países que SÍ tienen recarga se calcula de antemano (build-topup-
  // countries.js, corrido manualmente contra la API real de Zendit) y se
  // guarda en /topup_countries.json — { "GT": "Guatemala", ... }. Así el
  // buscador no ofrece países sin cobertura (ej. Portugal) desde el
  // primer tecleo, sin tener que consultar a Zendit en cada letra.
  //
  // Si el archivo no existe todavía o falla la carga, no rompemos nada:
  // simplemente mostramos la lista completa de países como antes (mismo
  // comportamiento de respaldo que ya usa zendit.js con zendit_prices.json).
  let topupCountryCodes = null; // null = aún no cargó / no disponible → sin filtrar

  async function loadTopupCoverage() {
    try {
      const resp = await fetch("/topup_countries.json");
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && typeof data === "object") {
        topupCountryCodes = new Set(Object.keys(data));
        // Si el usuario ya escribió algo antes de que esto cargara,
        // refrescamos las sugerencias con el filtro ya aplicado.
        if (document.activeElement === countryInput) renderCountrySuggestions(countryInput.value);
      }
    } catch (err) {
      console.warn("[Recharge] No se pudo cargar topup_countries.json, mostrando todos los países:", err.message);
    }
  }
  loadTopupCoverage();

  // Mismo valor de comisión de PayPal ya usado en checkout.js/coupon.js
  // (paypalFee: 0.11) — lo reutilizo aquí para mantener el mismo criterio
  // de negocio en todo el sitio, no un número nuevo inventado.
  const PAYPAL_FEE = 0.11;

  // Las ofertas de Top-Up usan el campo "price" (no "cost" como eSIM).
  //
  // Precio final = precio SUGERIDO por Zendit (ya trae el margen que
  // ellos recomiendan) + comisión de PayPal encima, con la misma fórmula
  // "breakeven" que ya usa checkout.js/coupon.js: precio / (1 - comisión)
  // — así lo que PayPal descuenta no reduce el precio que Zendit sugiere.
  // No se aplica ningún margen propio adicional sobre esto.
  //
  // Si una oferta puntual no trae "suggestedFixed" (puede pasar en
  // algunas), se usa "fixed" (o "min") como respaldo, para no dejarla
  // sin precio — pero eso sería el costo base, sin margen de Zendit.
  function getTopupPrice(offer) {
    const p = offer.price || offer.cost || {};
    const divisor = Number(p.currencyDivisor) || 100;
    const suggestedFixed = Number(p.suggestedFixed) || 0;
    const fixed = Number(p.fixed) || 0;
    const min = Number(p.min) || 0;

    const base = suggestedFixed > 0 ? suggestedFixed / divisor
      : fixed > 0 ? fixed / divisor
      : min > 0 ? min / divisor
      : 0;
    if (base <= 0) return 0;

    const withPaypalFee = base / (1 - PAYPAL_FEE);
    return Math.ceil(withPaypalFee * 100) / 100; // redondeo hacia arriba a centavos
  }

  // ── Buscador de país con autocompletado (mismo patrón que el
  //    asesor de viaje y el buscador del home) — permite escribir
  //    O elegir de la lista, en vez de un <select> fijo.
  function buildCountryList() {
    return Object.entries(COUNTRY_CODE) // { "GT": "Guatemala", ... }
      .map(([code, name]) => ({ code, name }))
      // Si ya tenemos la cobertura pre-calculada, ocultamos los países sin
      // recarga disponible (ej. Portugal) desde la lista misma — el usuario
      // nunca los ve ni pierde tiempo seleccionándolos para toparse con un
      // mensaje de "no disponible" después.
      .filter((c) => !topupCountryCodes || topupCountryCodes.has(c.code))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderCountrySuggestions(query) {
    const q = query.trim().toLowerCase();
    const all = buildCountryList();
    const matches = q
      ? all.filter((c) => c.name.toLowerCase().includes(q))
      : all;

    if (!matches.length) { countrySuggestions.classList.remove("open"); countrySuggestions.innerHTML = ""; return; }

    countrySuggestions.innerHTML = matches.map((c) =>
      `<div class="topup-country-item" data-code="${c.code}" data-name="${c.name}">
        <span>${(typeof COUNTRY_FLAG !== "undefined" && COUNTRY_FLAG[c.code]) || ""}</span><span>${c.name}</span>
      </div>`
    ).join("");

    countrySuggestions.querySelectorAll(".topup-country-item").forEach((item) => {
      item.addEventListener("click", () => selectCountry(item.dataset.code, item.dataset.name));
    });
    countrySuggestions.classList.add("open");
  }

  function selectCountry(code, name) {
    selectedCountryCode = code;
    selectedCountryName = name;
    countryInput.value = name;
    countrySuggestions.classList.remove("open");
    loadOffersForCountry(code);
  }

  countryInput.addEventListener("focus", () => renderCountrySuggestions(countryInput.value));
  countryInput.addEventListener("input", () => {
    // Si el usuario vuelve a escribir después de haber elegido un país,
    // se invalida la selección hasta que elija de nuevo de la lista —
    // así nunca se manda una recarga al país equivocado por un texto
    // que no coincide con ningún código real.
    if (selectedCountryName !== countryInput.value) {
      selectedCountryCode = null;
      operatorRow.style.display = "none";
      offersRow.style.display = "none";
      recipientCard.style.display = "none";
    }
    renderCountrySuggestions(countryInput.value);
  });
  document.addEventListener("click", (e) => {
    if (!countryInput.contains(e.target) && !countrySuggestions.contains(e.target)) {
      countrySuggestions.classList.remove("open");
    }
  });

  async function loadOffersForCountry(countryCode) {
    operatorRow.style.display = "block";
    offersRow.style.display = "none";
    recipientCard.style.display = "none";
    selectedOffer = null;
    selectedBrand = null;
    operatorGrid.innerHTML = `<div class="topup-loading">Buscando operadoras disponibles...</div>`;

    try {
      // Paginación: algunos países tienen más de 100 ofertas; se piden todas
      // las páginas (tope de seguridad: 10 páginas = 1000 ofertas) y se
      // eliminan duplicados por offerId.
      const PAGE = 100, MAX_PAGES = 10;
      const rawOffers = [];
      const seen = new Set();
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await ZenditAPI.getTopupOffers({ country: countryCode, limit: PAGE, offset: page * PAGE, subType: "Mobile Top Up" });
        const list = data.list || [];
        list.forEach((o) => { if (!seen.has(o.offerId)) { seen.add(o.offerId); rawOffers.push(o); } });
        const total = Number(data.total) || 0;
        if (list.length < PAGE || (total && (page + 1) * PAGE >= total)) break;
      }
      // v1: solo ofertas de precio FIJO — las de monto variable (RANGE)
      // necesitan un selector de monto propio, pendiente para una v2.
      allOffersForCountry = rawOffers.filter((o) => o.priceType === "FIXED" && o.enabled !== false);

      if (!allOffersForCountry.length) {
        operatorGrid.innerHTML = `<div class="topup-empty">No encontramos recargas de monto fijo para este país por ahora.</div>`;
        return;
      }

      // Agrupar por operadora — un país puede tener varias (Tigo, Claro,
      // Digicel, etc.), y el usuario debe elegir la SUYA antes de ver
      // montos, para no mezclar operadoras distintas en una sola lista.
      const brands = {};
      allOffersForCountry.forEach((o) => {
        const key = o.brandName || o.brand || "Otra";
        if (!brands[key]) brands[key] = 0;
        brands[key]++;
      });
      const brandNames = Object.keys(brands).sort((a, b) => a.localeCompare(b));

      operatorGrid.innerHTML = brandNames.map((name) => `
        <div class="topup-operator-card" data-brand="${name}">
          <div class="topup-operator-name">${name}</div>
          <div class="topup-operator-count">${brands[name]} ${brands[name] === 1 ? "monto disponible" : "montos disponibles"}</div>
        </div>`).join("");

      operatorGrid.querySelectorAll(".topup-operator-card").forEach((card) => {
        card.addEventListener("click", () => {
          operatorGrid.querySelectorAll(".topup-operator-card").forEach((c) => c.classList.remove("selected"));
          card.classList.add("selected");
          selectOperator(card.dataset.brand);
        });
      });

    } catch (err) {
      console.error("[Recharge] Error cargando operadoras:", err);
      operatorGrid.innerHTML = `<div class="topup-empty">No pudimos cargar las operadoras disponibles.<br/><small style="color:#c0392b">${(err && err.message ? err.message : "").replace(/</g, "&lt;")}</small></div>`;
    }
  }

  function selectOperator(brandName) {
    selectedBrand = brandName;
    selectedOffer = null;
    recipientCard.style.display = "none";
    offersRow.style.display = "block";

    const offers = allOffersForCountry.filter((o) => (o.brandName || o.brand || "Otra") === brandName);
    offers.sort((a, b) => getTopupPrice(a) - getTopupPrice(b));

    offersGrid.innerHTML = offers.map((o, i) => {
      const price = getTopupPrice(o);
      const sendAmount = o.send && o.send.fixed ? (o.send.fixed / (o.send.currencyDivisor || 1)) : null;
      const sendCurrency = o.send ? o.send.currency : "";
      return `
        <div class="topup-offer-card" data-idx="${i}">
          <div class="topup-offer-amount">${sendAmount ? sendAmount + " " + sendCurrency : (o.shortNotes || "Recarga")}</div>
          <div class="topup-offer-price">$${price.toFixed(2)} USD</div>
        </div>`;
    }).join("");

    offersGrid.querySelectorAll(".topup-offer-card").forEach((card) => {
      card.addEventListener("click", () => {
        offersGrid.querySelectorAll(".topup-offer-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        selectedOffer = offers[parseInt(card.dataset.idx, 10)];
        recipientCard.style.display = "block";
        recipientCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });

    offersRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  continueBtn.addEventListener("click", () => {
    errorEl.style.display = "none";

    if (!selectedOffer) {
      errorEl.textContent = "Selecciona un monto de recarga primero.";
      errorEl.style.display = "block";
      return;
    }
    const phone = phoneInput.value.trim();
    const email = emailInput.value.trim();

    if (!/^\+[1-9]\d{6,14}$/.test(phone.replace(/[\s-]/g, ""))) {
      errorEl.textContent = "Ingresa el número con el código de país, ej. +502 5555 5555.";
      errorEl.style.display = "block";
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errorEl.textContent = "Ingresa un correo electrónico válido.";
      errorEl.style.display = "block";
      return;
    }

    const price = getTopupPrice(selectedOffer);
    const params = new URLSearchParams({
      offerId: selectedOffer.offerId,
      price: price.toFixed(2),
      brand: selectedOffer.brandName || selectedOffer.brand || "",
      country: selectedCountryName || "",
      recipientPhone: phone.replace(/[\s-]/g, ""),
      senderEmail: email,
    });
    window.location.href = `topup-checkout.html?${params.toString()}`;
  });
})();
