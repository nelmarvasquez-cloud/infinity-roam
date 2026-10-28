// ============================================================
//  ADVISOR.JS — Asesor de viaje para elegir plan
// ============================================================
// Reutiliza datos y funciones YA existentes en el sitio (no duplica
// estructuras): COUNTRY_ES/COUNTRY_CODE/COUNTRY_FLAG y
// getCountryFromOfferId (countries.js), getPlanPrice (zendit.js),
// y el mismo endpoint /.netlify/functions/catalog que usa catalog.js.

(function () {
  const overlay = document.getElementById("advisor-overlay");
  const trigger = document.getElementById("advisor-trigger");
  const closeBtn = document.getElementById("advisor-close");
  if (!overlay || !trigger) return;

  const progressBar = document.getElementById("advisor-progress-bar");
  const destInput = document.getElementById("advisor-destination-input");
  const suggestBox = document.getElementById("advisor-suggestions");
  const daysGrid = document.getElementById("advisor-days-grid");
  const submitBtn = document.getElementById("advisor-submit");

  const state = {
    destinationEN: null,
    destinationDisplay: null,
    days: null,
    activities: [],
    step: 1,
  };

  let catalogCache = null; // cache: solo se pide una vez por sesión de página

  // Interpolación simple sobre t() de i18n.js: tf("advisor_result_est", {gb: 15})
  function tf(key, vars) {
    let str = (typeof t === "function") ? t(key) : key;
    if (vars) Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
    return str;
  }

  // ── PESOS DE ESTIMACIÓN DE DATOS (GB por día) ──────────────
  const WEIGHTS = {
    base: 0.3,       // mensajería básica, siempre incluido
    maps: 0.3,       // navegación GPS
    social: 0.5,     // redes sociales (ver + publicar)
    translate: 0.2,  // traductor en vivo
    stream: 1.5,     // streaming de video/música
    work: 1.0,       // trabajo remoto / videollamadas
  };

  // ── ABRIR / CERRAR MODAL ────────────────────────────────────
  function openModal() {
    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";
    resetToStep(1);
    setTimeout(() => destInput?.focus(), 100);
    if (typeof gtag === "function") gtag("event", "advisor_open", {});
  }
  function closeModal() {
    overlay.style.display = "none";
    document.body.style.overflow = "";
  }
  trigger.addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.style.display === "flex") closeModal(); });

  // ── NAVEGACIÓN ENTRE PASOS ──────────────────────────────────
  function resetToStep(n) {
    state.step = n;
    ["1", "2", "3", "result"].forEach((s) => {
      const el = document.getElementById(`advisor-step-${s}`);
      if (el) el.style.display = String(s) === String(n) ? "block" : "none";
    });
    const pct = n === 1 ? 10 : n === 2 ? 40 : n === 3 ? 70 : 100;
    if (progressBar) progressBar.style.width = pct + "%";
  }

  // ── PASO 1: DESTINO (mismo patrón que el buscador del hero) ─
  function buildCountryList() {
    if (typeof COUNTRY_ES === "undefined") return [];
    return Object.keys(COUNTRY_ES).map((en) => ({ en, es: COUNTRY_ES[en] }));
  }
  function flagFor(enName) {
    if (typeof COUNTRY_CODE === "undefined" || typeof COUNTRY_FLAG === "undefined") return "🌍";
    const code = Object.keys(COUNTRY_CODE).find((k) => COUNTRY_CODE[k] === enName);
    return (code && COUNTRY_FLAG[code]) || "🌍";
  }
  function renderDestSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (!q) { suggestBox.classList.remove("open"); suggestBox.innerHTML = ""; return; }

    const lang = (typeof currentLang !== "undefined") ? currentLang : "es";
    const all = buildCountryList();
    const matches = all
      .filter((c) => c.en.toLowerCase().includes(q) || c.es.toLowerCase().includes(q))
      .slice(0, 6);
    if (!matches.length) { suggestBox.classList.remove("open"); suggestBox.innerHTML = ""; return; }
    suggestBox.innerHTML = matches.map((c) => {
      const display = lang === "es" ? c.es : c.en;
      return `<div class="advisor-suggestion-item" data-en="${c.en}" data-display="${display}">
        <span>${flagFor(c.en)}</span><span>${display}</span>
      </div>`;
    }).join("");
    suggestBox.querySelectorAll(".advisor-suggestion-item").forEach((item) => {
      item.addEventListener("click", () => selectDestination(item.dataset.en, item.dataset.display));
    });
    suggestBox.classList.add("open");
  }
  function selectDestination(en, display) {
    state.destinationEN = en;
    state.destinationDisplay = display;
    destInput.value = display;
    suggestBox.classList.remove("open");
    setTimeout(() => resetToStep(2), 250);
  }
  destInput?.addEventListener("input", () => renderDestSuggestions(destInput.value));
  destInput?.addEventListener("focus", () => renderDestSuggestions(destInput.value));
  document.addEventListener("click", (e) => {
    const wrap = document.getElementById("advisor-search-wrap");
    if (wrap && !wrap.contains(e.target)) suggestBox?.classList.remove("open");
  });

  // ── PASO 2: DÍAS ─────────────────────────────────────────────
  daysGrid?.querySelectorAll(".advisor-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      daysGrid.querySelectorAll(".advisor-option").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.days = parseInt(btn.dataset.days, 10);
      setTimeout(() => resetToStep(3), 250);
    });
  });

  // ── PASO 3: ACTIVIDADES ──────────────────────────────────────
  submitBtn?.addEventListener("click", () => {
    const checked = document.querySelectorAll("#advisor-activities input[type=checkbox]:checked");
    state.activities = Array.from(checked).map((c) => c.value);
    resetToStep("result");
    runRecommendation();
  });

  // ── CÁLCULO DE GB NECESARIOS ─────────────────────────────────
  function estimateGB(days, activities) {
    let perDay = WEIGHTS.base;
    activities.forEach((a) => { if (WEIGHTS[a]) perDay += WEIGHTS[a]; });
    return Math.ceil(perDay * days);
  }

  // ── CATÁLOGO (mismo endpoint que catalog.js) ─────────────────
  async function getCatalog() {
    if (catalogCache) return catalogCache;
    const resp = await fetch("/.netlify/functions/catalog");
    if (!resp.ok) throw new Error("catalog_fetch_failed");
    const data = await resp.json();
    catalogCache = data.list || [];
    return catalogCache;
  }

  function offerCountry(offer) {
    if (offer.country && !offer.country.startsWith("Regional")) return offer.country;
    if (typeof getCountryFromOfferId === "function") {
      const c = getCountryFromOfferId(offer.offerId);
      if (c) return c;
    }
    return "";
  }
  function offerPrice(offer) {
    if (typeof getPlanPrice === "function") return parseFloat(getPlanPrice(offer)) || 0;
    const c = offer.cost || {};
    const fixed = Number(c.fixed) || 0;
    const div = Number(c.currencyDivisor) || 100;
    return fixed > 0 ? (fixed / div) * 1.5 : 0;
  }

  // Si el plan ilimitado más barato cuesta hasta este % más que el mejor
  // plan de datos fijos que alcanza, se recomienda el ilimitado (la
  // flexibilidad extra vale la pena cuando el precio es similar). Si
  // cuesta más que eso, se recomienda el de datos fijos.
  const UNLIMITED_PREFERENCE_MARGIN = 1.3; // hasta 30% más caro

  function dedupeSamePlan(offers) {
    // Mismo país/región + misma cantidad de datos + misma duración → se
    // queda solo el más barato (igual que hace catalog.js en filterOffers).
    const seen = new Map();
    for (const offer of offers) {
      const groupKey = offer.isRegional ? (offer.region || "unknown") : offerCountry(offer);
      const days = offer.durationDays || 0;
      const price = offerPrice(offer);
      const key = offer.dataUnlimited ? `${groupKey}|unlimited|${days}` : `${groupKey}|${offer.dataGB || 0}gb|${days}`;
      if (!seen.has(key) || price < seen.get(key).price) seen.set(key, { offer, price });
    }
    return [...seen.values()].map((v) => v.offer);
  }

  function findCandidates(offers, destinationEN, days) {
    // 1) Planes de PAÍS específico que cubran la duración del viaje
    const countryPlans = offers.filter((o) =>
      !o.isRegional &&
      offerCountry(o) === destinationEN &&
      (o.durationDays || 0) >= days
    );
    if (countryPlans.length) return dedupeSamePlan(countryPlans);

    // 2) Si no hay plan de país, buscar planes REGIONALES cuyo coverage incluya el destino
    const regionalPlans = offers.filter((o) =>
      o.isRegional &&
      Array.isArray(o.coverageCountries) &&
      o.coverageCountries.some((c) => c === destinationEN) &&
      (o.durationDays || 0) >= days
    );
    return dedupeSamePlan(regionalPlans);
  }

  function pickBest(candidates, gbNeeded) {
    if (!candidates.length) return [];

    // 1) PRINCIPAL — el plan de datos fijos MÁS BARATO que alcanza el
    //    estimado, sin restringirlo a una sola duración (mientras cubra
    //    el viaje). Esta es la recomendación honesta y costo-efectiva:
    //    un plan de mayor duración pero más barato SÍ debe poder ganarle
    //    a uno de duración "exacta" pero más caro.
    const fixedEnough = candidates
      .filter((o) => !o.dataUnlimited && (o.dataGB || 0) >= gbNeeded)
      .sort((a, b) => offerPrice(a) - offerPrice(b) || (a.durationDays || 0) - (b.durationDays || 0));
    const bestFixed = fixedEnough[0] || null;

    // 2) ALTERNATIVA — el plan ILIMITADO cuya duración se ajusta mejor al
    //    viaje (la más corta que aún lo cubra, para no pagar de más por
    //    validez que no se va a usar). Se ofrece siempre explícitamente
    //    por flexibilidad de datos, nunca presentado como "mejor oferta".
    const unlimitedSorted = candidates
      .filter((o) => o.dataUnlimited)
      .sort((a, b) => (a.durationDays || 0) - (b.durationDays || 0) || offerPrice(a) - offerPrice(b));
    const bestUnlimited = unlimitedSorted[0] || null;

    let primary, rest = [];
    if (bestFixed) {
      primary = bestFixed;
      if (bestUnlimited) {
        bestUnlimited.__advisorFlexPick = true;
        rest.push(bestUnlimited);
      }
      rest.push(...fixedEnough.slice(1));
    } else if (bestUnlimited) {
      primary = bestUnlimited;
      rest = unlimitedSorted.slice(1);
    } else {
      // Ningún plan alcanza el estimado — mostrar el de más datos
      // disponible entre los candidatos (igual cubren el viaje en días).
      const byData = [...candidates].sort((a, b) => {
        if (a.dataUnlimited || b.dataUnlimited) return a.dataUnlimited ? -1 : 1;
        return (b.dataGB || 0) - (a.dataGB || 0);
      });
      primary = byData[0];
      rest = byData.slice(1);
    }

    // Dedupe final por si un mismo offer terminó en ambas listas, y limitar a 2 alternativas
    const seenIds = new Set([primary.offerId]);
    const alternatives = [];
    for (const o of rest) {
      if (seenIds.has(o.offerId)) continue;
      seenIds.add(o.offerId);
      alternatives.push(o);
      if (alternatives.length >= 2) break;
    }
    return [primary, ...alternatives];
  }

  async function runRecommendation() {
    const loading = document.getElementById("advisor-loading");
    const resultContent = document.getElementById("advisor-result-content");
    loading.style.display = "block";
    resultContent.style.display = "none";

    try {
      const offers = await getCatalog();
      const gbNeeded = estimateGB(state.days, state.activities);
      const candidates = findCandidates(offers, state.destinationEN, state.days);
      const ranked = pickBest(candidates, gbNeeded);

      loading.style.display = "none";
      resultContent.style.display = "block";

      if (typeof gtag === "function") {
        gtag("event", "advisor_result", {
          destination: state.destinationEN, days: state.days,
          activities: state.activities.join(","), gb_estimated: gbNeeded,
          plans_found: ranked.length,
        });
      }

      if (!ranked.length) {
        resultContent.innerHTML = `
          <div class="advisor-empty">
            <p class="advisor-empty-icon">🤔</p>
            <p class="advisor-empty-title">${tf("advisor_empty_title", { dest: state.destinationDisplay })}</p>
            <p class="advisor-empty-desc">${tf("advisor_empty_desc", { dest: state.destinationDisplay })}</p>
            <a class="advisor-cta-btn" href="catalog.html?search=${encodeURIComponent(state.destinationEN)}">${tf("advisor_empty_cta", { dest: state.destinationDisplay })}</a>
          </div>`;
        return;
      }

      const primary = ranked[0];
      const alternatives = ranked.slice(1, 3);
      resultContent.innerHTML = renderResult(primary, alternatives, gbNeeded);
      wireResultButtons();
    } catch (err) {
      console.error("[Advisor] Error:", err.message);
      loading.style.display = "none";
      resultContent.style.display = "block";
      resultContent.innerHTML = `
        <div class="advisor-empty">
          <p class="advisor-empty-icon">⚠️</p>
          <p class="advisor-empty-title">${t("advisor_error_title")}</p>
          <p class="advisor-empty-desc">${t("advisor_error_desc")}</p>
          <a class="advisor-cta-btn" href="catalog.html">${t("advisor_error_cta")}</a>
        </div>`;
    }
  }

  function planCardHTML(offer, isPrimary) {
    const lang = (typeof currentLang !== "undefined") ? currentLang : "es";
    const dataText = offer.dataUnlimited ? t("advisor_unlimited") : `${offer.dataGB || 0} GB`;
    const price = offerPrice(offer);
    const name = offer.isRegional
      ? (lang === "es" ? (offer.regionNameEs || offer.regionName) : (offer.regionName || offer.regionNameEs)) || "Regional"
      : (lang === "es"
          ? ((typeof COUNTRY_ES !== "undefined" && COUNTRY_ES[offerCountry(offer)]) || offerCountry(offer))
          : offerCountry(offer));
    const flexBadge = !isPrimary && offer.__advisorFlexPick
      ? `<div class="advisor-plan-badge flex">${t("advisor_badge_flex")}</div>`
      : "";
    return `
      <div class="advisor-plan-card ${isPrimary ? "primary" : ""}">
        ${isPrimary ? `<div class="advisor-plan-badge">${t("advisor_badge_primary")}</div>` : flexBadge}
        <div class="advisor-plan-name">${name}</div>
        <div class="advisor-plan-specs">
          <span>${dataText}</span><span>·</span><span>${offer.durationDays || 0} ${t("advisor_days_unit")}</span>
        </div>
        <div class="advisor-plan-price">$${price.toFixed(2)} <span>USD</span></div>
        <button type="button" class="advisor-plan-btn"
          data-offer-id="${offer.offerId}" data-price="${price}"
          data-name="${encodeURIComponent(name)}" data-destination="${encodeURIComponent(state.destinationDisplay)}"
          data-plan-type="${offer.isRegional ? "regional" : "country"}" data-duration="${offer.durationDays || 0}"
          data-data-amount="${offer.dataUnlimited ? "unlimited" : (offer.dataGB || 0) + "GB"}">
          ${isPrimary ? t("advisor_btn_buy") : t("advisor_btn_view")}
        </button>
      </div>`;
  }

  function renderResult(primary, alternatives, gbNeeded) {
    return `
      <div class="advisor-result-header">
        <p class="advisor-result-eyebrow">${tf("advisor_result_eyebrow", { days: state.days, dest: state.destinationDisplay })}</p>
        <p class="advisor-result-est">${tf("advisor_result_est", { gb: gbNeeded })}</p>
      </div>
      <div class="advisor-plans-grid">
        ${planCardHTML(primary, true)}
        ${alternatives.map((o) => planCardHTML(o, false)).join("")}
      </div>
      <a class="advisor-see-more" href="catalog.html?search=${encodeURIComponent(state.destinationEN)}">${tf("advisor_see_more", { dest: state.destinationDisplay })}</a>`;
  }

  function wireResultButtons() {
    document.querySelectorAll(".advisor-plan-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const price = btn.dataset.price;
        const name = btn.dataset.name;
        const destination = btn.dataset.destination;
        const planType = btn.dataset.planType;
        const duration = btn.dataset.duration;
        const dataAmount = btn.dataset.dataAmount;
        if (typeof gtag === "function") {
          gtag("event", "select_plan", {
            item_id: btn.dataset.offerId, item_name: decodeURIComponent(name),
            destination: decodeURIComponent(destination), source: "advisor",
          });
        }
        window.location.href = `checkout.html?offerId=${btn.dataset.offerId}&price=${price}&name=${name}&destination=${destination}&planType=${planType}&duration=${duration}&dataAmount=${dataAmount}`;
      });
    });
  }
})();
