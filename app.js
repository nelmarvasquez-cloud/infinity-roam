// ============================================================
//  APP.JS — Homepage
// ============================================================
// NOTA: el manejo del FAQ, el menú hamburguesa y el toggle de idioma
// del home ahora viven en el <script> inline de index.html (usan las
// clases .ir-faq-*, .ir-nav-links, etc.). Antes había aquí una copia
// legacy con las clases viejas (.faq-q, .faq-item, .nav-links) que ya
// no existen en la página — quedaba como código muerto, pero además
// declaraba "const hamburger" duplicado respecto al script de
// index.html. Como ambos <script> comparten el mismo scope global,
// eso lanzaba "SyntaxError: Can't create duplicate variable: hamburger"
// y esto rompía TODO el bloque de script de index.html donde vive el
// FAQ — por eso las preguntas no desplegaban la respuesta al hacer clic.

function getLang() {
  const saved = localStorage.getItem("ir_lang");
  if (saved === "en" || saved === "es") return saved;
  const browser = (navigator.language || "en").toLowerCase();
  return browser.startsWith("es") ? "es" : "en";
}

function renderPlanCard(offer) {
  const lang = getLang();

  // Usar precio sugerido por Zendit si está disponible, sino usar markup
  const price = (typeof getPlanPrice === "function")
    ? getPlanPrice(offer)
    : (() => {
        const costObj = offer.cost || {};
        const fixed = Number(costObj.fixed) || 0;
        const divisor = Number(costObj.currencyDivisor) || 100;
        const rawPrice = fixed > 0 ? fixed / divisor : 0;
        return rawPrice > 0 ? (rawPrice * CONFIG.MARKUP).toFixed(2) : "0.00";
      })();

  let dataText;
  if (offer.dataUnlimited) {
    dataText = lang === "es" ? "Datos ilimitados" : "Unlimited data";
  } else if (offer.dataGB > 0) {
    dataText = offer.dataGB + " GB";
  } else {
    dataText = lang === "es" ? "Datos incluidos" : "Data included";
  }

  let daysText = "";
  if (offer.durationDays > 0) {
    daysText = offer.durationDays + (lang === "es" ? " días" : " days");
  }

  const name = (typeof getPlanName === "function") ? getPlanName(offer, lang) : "eSIM";
  const region = detectRegion(offer);

  const regionEmoji = { global:"🌍", europe:"🇪🇺", asia:"🌏", americas:"🌎", middleeast:"🕌", other:"📡" }[region] || "📡";

  const regionLabel = lang === "es"
    ? { global:"Global", europe:"Europa", asia:"Asia", americas:"Américas", middleeast:"Medio Oriente", other:"Internacional" }[region] || "Internacional"
    : { global:"Global", europe:"Europe", asia:"Asia", americas:"Americas", middleeast:"Middle East", other:"International" }[region] || "International";

  const instantText = lang === "es" ? "Activación instantánea" : "Instant activation";
  const buyText = lang === "es" ? "Comprar" : "Buy";

  return `
    <div class="plan-card" data-offer-id="${offer.offerId}">
      <div class="plan-card-header">
        <span class="plan-flag">${regionEmoji}</span>
        <span class="plan-region-tag">${regionLabel}</span>
      </div>
      <h3 class="plan-name">${name}</h3>
      <div class="plan-features">
        <div class="plan-feature"><span class="feature-icon">📶</span><span>${dataText}</span></div>
        ${daysText ? `<div class="plan-feature"><span class="feature-icon">📅</span><span>${daysText}</span></div>` : ""}
        <div class="plan-feature"><span class="feature-icon">⚡</span><span>${instantText}</span></div>
      </div>
      <div class="plan-footer">
        <div class="plan-price">
          <span class="price-amount">${formatPrice(price)}</span>
          <span class="price-label">USD</span>
        </div>
        <button class="btn-buy"
          data-offer-id="${offer.offerId}"
          data-price="${price}"
          data-name="${encodeURIComponent(name)}">
          ${buyText}
        </button>
      </div>
    </div>
  `;
}

function attachBuyButtons() {
  document.querySelectorAll(".btn-buy").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.location.href = `checkout.html?offerId=${btn.dataset.offerId}&price=${btn.dataset.price}&name=${btn.dataset.name}`;
    });
  });
}

async function loadFeaturedPlans() {
  const grid = document.getElementById("featured-grid");
  if (!grid) return;

  // Planes curados: baratos, variados, bajo $20, estética uniforme
  const FEATURED = [
    { flag:"🇩🇪", country:"Alemania",    countryEN:"Germany",       data:"2GB",  days:15, price:"3.19", offerId:"ESIM-DE-15D-2GB-NOROAM" },
    { flag:"🇪🇸", country:"España",      countryEN:"Spain",         data:"2GB",  days:15, price:"3.19", offerId:"ESIM-ES-15D-2GB-NOROAM" },
    { flag:"🇬🇧", country:"Reino Unido", countryEN:"United Kingdom",data:"2GB",  days:15, price:"3.25", offerId:"ESIM-GB-15D-2GB-NOROAM" },
    { flag:"🇯🇵", country:"Japón",       countryEN:"Japan",         data:"1GB",  days:7,  price:"3.27", offerId:"ESIM-JP-7D-1GB-NOROAM"  },
    { flag:"🇫🇷", country:"Francia",     countryEN:"France",        data:"3GB",  days:30, price:"3.82", offerId:"ESIM-FR-30D-3GB-NOROAM" },
    { flag:"🇮🇹", country:"Italia",      countryEN:"Italy",         data:"3GB",  days:30, price:"3.82", offerId:"ESIM-IT-30D-3GB-NOROAM" },
  ];

  const lang = getLang();
  const daysLabel = lang === "es" ? "días" : "days";
  const buyLabel  = lang === "es" ? "Comprar →" : "Buy →";

  // Variedad de degradados (mismo tratamiento visual que las 3 tarjetas fijas de arriba)
  const GRADIENTS = [
    "linear-gradient(135deg, #16223F 0%, #2864E6 100%)",
    "linear-gradient(135deg, #16223F 0%, #4A90E8 100%)",
    "linear-gradient(135deg, #223257 0%, #2864E6 60%, #4A90E8 100%)",
  ];

  grid.innerHTML = FEATURED.map((p, i) => `
    <div class="ir-plan-card" data-offer-id="${p.offerId}">
      <div class="ir-plan-photo" style="--plan-gradient: ${GRADIENTS[i % GRADIENTS.length]};">
        <div class="ir-plan-top">
          <span class="ir-plan-flag">${p.flag}</span>
          <div class="ir-plan-country">${lang === "es" ? p.country : p.countryEN}</div>
          <div class="ir-plan-name">${p.data} · ${p.days} ${daysLabel}</div>
        </div>
        <div class="ir-plan-details">
          <span class="ir-plan-chip">📶 ${p.data}</span>
          <span class="ir-plan-chip">📅 ${p.days} ${daysLabel}</span>
          <span class="ir-plan-chip">⚡ 4G/LTE</span>
        </div>
      </div>
      <div class="ir-plan-footer">
        <div class="ir-plan-price">
          <span class="ir-plan-price-amt">$${p.price}</span>
          <span class="ir-plan-price-cur">USD</span>
        </div>
        <button class="ir-plan-btn" data-offer-id="${p.offerId}" data-price="${p.price}" data-name="${encodeURIComponent(p.data + ' ' + p.days + ' ' + daysLabel + ' ' + (lang==='es'?p.country:p.countryEN))}">
          ${buyLabel}
        </button>
      </div>
    </div>
  `).join("");

  // Attach buy buttons
  grid.querySelectorAll(".ir-plan-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      window.location.href = `checkout.html?offerId=${btn.dataset.offerId}&price=${btn.dataset.price}&name=${btn.dataset.name}`;
    });
  });
}

window.addEventListener("scroll", () => {
  const nav = document.querySelector(".nav");
  if (nav) nav.classList.toggle("scrolled", window.scrollY > 40);
});

// Recargar planes cuando cambia el idioma
window.addEventListener("ir_lang_changed", () => {
  loadFeaturedPlans();
});

loadFeaturedPlans();
