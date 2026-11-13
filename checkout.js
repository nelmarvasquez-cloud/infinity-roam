// ============================================================
//  CHECKOUT.JS — Con sistema de cupones
// ============================================================

const params = new URLSearchParams(window.location.search);
const offerId = params.get("offerId");
let planPrice = parseFloat(params.get("price") || "0"); // precio POR UNIDAD — no se toca por cantidad
const planName = decodeURIComponent(params.get("name") || "Plan eSIM");
const planDestination = decodeURIComponent(params.get("destination") || "");
const planType = params.get("planType") || "";
const planDuration = parseInt(params.get("duration"), 10) || 0;
const planDataAmount = params.get("dataAmount") || "";
const MAX_QUANTITY = 5;
const quantity = Math.min(MAX_QUANTITY, Math.max(1, parseInt(params.get("quantity"), 10) || 1));

// ── TRACKING: view_item (GA4 + Meta ViewContent) ──
// Se dispara al cargar checkout.html con un plan específico — es la
// "ficha de producto" de este sitio (no hay página de detalle separada).
// No altera ninguna variable ni lógica de precio/cupón/PayPal existente.
if (offerId) {
  const utms = (typeof getStoredUTMs === "function") ? getStoredUTMs() : {};
  const viewItemId = (typeof generateEventId === "function") ? generateEventId("view_item") : "";

  if (typeof gtag === "function") {
    gtag("event", "view_item", {
      currency: "USD",
      value: planPrice,
      items: [{ item_id: offerId, item_name: planName, price: planPrice, quantity: 1 }],
      destination: planDestination,
      plan_type: planType,
      duration: planDuration,
      data_amount: planDataAmount,
      utm_source: utms.utm_source, utm_medium: utms.utm_medium,
      utm_campaign: utms.utm_campaign, utm_content: utms.utm_content,
    });
  }
  if (typeof fbq === "function") {
    fbq("track", "ViewContent", {
      content_ids: [offerId], content_name: planName,
      value: planPrice, currency: "USD",
    }, { eventID: viewItemId });
  }
  if (typeof sendToCAPI === "function") {
    sendToCAPI("ViewContent", viewItemId, {
      content_ids: [offerId], content_name: planName,
      value: planPrice, currency: "USD",
    });
  }
  window.debugAnalytics && window.debugAnalytics("GA4+Meta", "view_item / ViewContent", { offerId, planPrice });

  // TRACKING: Clarity custom tag "destination" — permite buscar en Clarity
  // (Filters → Custom tags) todas las sesiones que vieron este destino.
  // No es PII: es el nombre del país/región del plan.
  if (typeof clarity === "function" && planDestination) {
    clarity("set", "destination", planDestination);
  }
}

// ── TRACKING: begin_checkout (GA4 + Meta InitiateCheckout) ──
// Se dispara SOLO cuando el usuario interactúa por primera vez con el
// formulario (foco en el campo de email) — no simplemente al cargar la
// página. Protegido contra doble disparo con un flag local.
let _beginCheckoutFired = false;
function trackBeginCheckoutOnce() {
  if (_beginCheckoutFired || !offerId) return;
  _beginCheckoutFired = true;

  const utms = (typeof getStoredUTMs === "function") ? getStoredUTMs() : {};
  const eventId = (typeof generateEventId === "function") ? generateEventId("begin_checkout") : "";
  const priceNow = typeof finalPrice !== "undefined" ? finalPrice : planPrice;

  if (typeof gtag === "function") {
    gtag("event", "begin_checkout", {
      currency: "USD",
      value: priceNow,
      items: [{ item_id: offerId, item_name: planName, price: priceNow, quantity: 1 }],
      destination: planDestination,
      plan_type: planType,
      duration: planDuration,
      data_amount: planDataAmount,
      utm_source: utms.utm_source, utm_medium: utms.utm_medium,
      utm_campaign: utms.utm_campaign, utm_content: utms.utm_content,
    });
  }
  if (typeof fbq === "function") {
    fbq("track", "InitiateCheckout", {
      content_ids: [offerId], content_name: planName,
      value: priceNow, currency: "USD",
    }, { eventID: eventId });
  }
  if (typeof sendToCAPI === "function") {
    sendToCAPI("InitiateCheckout", eventId, {
      content_ids: [offerId], content_name: planName,
      value: priceNow, currency: "USD",
    });
  }
  window.debugAnalytics && window.debugAnalytics("GA4+Meta", "begin_checkout / InitiateCheckout", { offerId, priceNow });
}
document.addEventListener("DOMContentLoaded", () => {
  const emailInput = document.getElementById("customer-email");
  if (emailInput) emailInput.addEventListener("focus", trackBeginCheckoutOnce, { once: true });
});

// ── TRACKING: errores de checkout/pago (GA4) ──────────────────────────────
// Categorías genéricas y seguras. NUNCA se envía el mensaje de error crudo
// (podría contener detalles del procesador), ni email, ni datos de pago.
// paymentCaptured distingue "no llegó a pagar" de "pagó pero algo falló
// después" — la distinción prioritaria pedida para esta fase.
function trackCheckoutError(eventName, category, paymentCaptured) {
  if (typeof gtag === "function") {
    gtag("event", eventName, {
      error_category: category,
      checkout_step: paymentCaptured ? "provisioning" : "payment",
      payment_method_type: "paypal",
      item_id: offerId || "",
      destination: planDestination,
      value: (typeof finalPrice !== "undefined" ? finalPrice : planPrice),
      currency: "USD",
    });
  }
  // TRACKING: Clarity custom tag "checkout_outcome" — permite filtrar
  // grabaciones directamente por resultado (ej: payment_cancelled,
  // payment_failed, checkout_error) para investigar visualmente qué pasó.
  if (typeof clarity === "function") {
    clarity("set", "checkout_outcome", eventName);
  }
  window.debugAnalytics && window.debugAnalytics("GA4", eventName, { category, paymentCaptured });
}

// Estado del cupón / referido — solo uno puede estar activo
let appliedCoupon = null;
let appliedReferral = null; // { code, referrer_name, discount }
let finalPrice = planPrice;

// ============================================================
//  CUPONES Y REFERIDOS — el precio con descuento lo calcula el SERVIDOR
// ============================================================
// checkout.js es público: aquí no hay códigos, ni costos de los planes, ni
// fórmulas de descuento. El navegador envía (offerId, código) y recibe el
// precio final por unidad (netlify/functions/coupon.js y referral.js, que
// usan lib/pricing.js). Con un precio inválido (no menor al de lista) no se
// aplica descuento.
function serverPrice(value) {
  const p = Number(value);
  return (p > 0 && p <= planPrice) ? Math.round(p * 100) / 100 : planPrice;
}

async function applyCode() {
  const input = document.getElementById("coupon-input");
  const code = (input.value || "").trim().toUpperCase();
  const errorEl = document.getElementById("coupon-error");
  const successEl = document.getElementById("coupon-success");
  const btn = document.getElementById("apply-coupon-btn");

  errorEl.style.display = "none";
  successEl.style.display = "none";
  if (!code) return;

  // Solo un código a la vez
  if (appliedCoupon || appliedReferral) {
    errorEl.textContent = "Ya tienes un código aplicado. Elimínalo primero.";
    errorEl.style.display = "block"; return;
  }

  // 1.5 Cupones: se validan en el servidor (país/fecha/lista de códigos — validado en el
  //     servidor porque el país/fecha del comprador no se puede confiar
  //     al navegador). Si no es un cupón de este tipo, sigue al paso 2.
  btn.disabled = true; btn.textContent = "Verificando...";
  try {
    const gr = await fetch("/.netlify/functions/coupon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, offerId }),
    });
    const gdata = await gr.json();
    if (gdata.valid) {
      const geoCoupon = { description: gdata.description };
      appliedCoupon = { ...geoCoupon, code };
      appliedReferral = null;
      finalPrice = serverPrice(gdata.finalPrice);
      successEl.innerHTML = `✅ Código <strong>${code}</strong> aplicado — ${geoCoupon.description}`;
      successEl.style.display = "flex";
      input.disabled = true;
      btn.disabled = true; btn.textContent = "Aplicado";
      updateSummary(); rebuildPayPalButton(); return;
    }
    // Si existe pero no aplica (mala fecha/país), avisar específicamente
    // y no seguir intentando como código de referido.
    if (gdata.reason && gdata.reason !== "not_found") {
      const messages = {
        expired: "Este código ya no está disponible (fuera de su período de vigencia).",
        wrong_country: "Este código solo está disponible para compras desde Panamá.",
        country_undetectable: gdata.message || "No se pudo verificar tu ubicación. Intenta de nuevo.",
        rate_limited: gdata.message || "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
        bad_request: "No se pudo aplicar el código a este plan. Recarga la página e inténtalo de nuevo.",
      };
      errorEl.textContent = messages[gdata.reason] || "Código no disponible.";
      errorEl.style.display = "block";
      btn.disabled = false; btn.textContent = "Aplicar"; return;
    }
  } catch {
    // Si falla la verificación geo, no bloquea el flujo — simplemente
    // continúa al paso 2 (podría ser un código de referido normal).
  }

  // 2. Try as referral code
  btn.disabled = true; btn.textContent = "Verificando...";
  try {
    const r = await fetch("/.netlify/functions/referral?action=validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, offerId }),
    });
    const data = await r.json();
    if (!r.ok || !data.valid) {
      errorEl.textContent = data.error || "Código inválido. Verifica e intenta de nuevo.";
      errorEl.style.display = "block";
      btn.disabled = false; btn.textContent = "Aplicar"; return;
    }
    // Valid referral
    appliedReferral = { code, referrer_name: data.referrer.name, discount: data.discount };
    appliedCoupon = null;
    finalPrice = serverPrice(data.finalPrice);
    successEl.innerHTML = `✅ Código de referido <strong>${code}</strong> aplicado — 5% de descuento`;
    successEl.style.display = "flex";
    input.disabled = true;
    btn.disabled = true; btn.textContent = "Aplicado";
    updateSummary(); rebuildPayPalButton();
  } catch {
    errorEl.textContent = "Error de conexión. Intenta de nuevo.";
    errorEl.style.display = "block";
    btn.disabled = false; btn.textContent = "Aplicar";
  }
}

// Alias para compatibilidad con onclick existente
function applyCoupon() { applyCode(); }

function updateSummary() {
  const card = document.getElementById("summary-card");
  const originalTag = appliedCoupon
    ? `<span class="summary-original-price">${formatPrice(planPrice)}</span>
       <span class="summary-discount-badge">DESCUENTO</span>`
    : "";
  const total = finalPrice * quantity;
  const qtyRow = quantity > 1
    ? `<div class="summary-row">
         <span data-i18n="checkout_quantity">Cantidad</span>
         <span>${quantity} × ${formatPrice(finalPrice)}</span>
       </div>`
    : "";

  card.innerHTML = `
    <div class="summary-plan-name">${planName}</div>
    <div class="summary-divider"></div>
    <div class="summary-row">
      <span data-i18n="checkout_subtotal">Subtotal</span>
      <span>${originalTag} ${formatPrice(finalPrice)}</span>
    </div>
    ${qtyRow}
    <div class="summary-row">
      <span data-i18n="checkout_fee">Comisión</span>
      <span>$0.00</span>
    </div>
    <div class="summary-row total">
      <span><strong data-i18n="checkout_total">Total</strong></span>
      <span><strong>${formatPrice(total)} USD</strong></span>
    </div>
    <div class="summary-note" data-i18n="checkout_note">
      ✅ Incluye activación + QR enviado por email
    </div>
  `;
}

function getEmail() {
  const email = document.getElementById("customer-email").value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function showError(msg) {
  const el = document.getElementById("checkout-error");
  el.textContent = msg;
  el.style.display = "block";
  document.getElementById("checkout-processing").style.display = "none";
}

function showProcessing() {
  document.getElementById("checkout-processing").style.display = "flex";
  document.getElementById("checkout-error").style.display = "none";
}

let paypalButtonsInstance = null;

function rebuildPayPalButton() {
  const container = document.getElementById("paypal-button-container");
  container.innerHTML = "";
  initPayPal();
}

function initPayPal() {
  if (!window.paypal) {
    setTimeout(initPayPal, 500);
    return;
  }

  const container = document.getElementById("paypal-button-container");
  if (!container) return;

  paypal.Buttons({
    style: {
      layout: "vertical",
      color: "black",
      shape: "rect",
      label: "pay",
      height: 48,
    },

    onClick(data, actions) {
      const email = getEmail();
      if (!email) {
        const msg = typeof t === "function"
          ? t("checkout_error_email")
          : "Por favor ingresa un correo electrónico válido antes de pagar.";
        showError(msg);
        return actions.reject();
      }
      return actions.resolve();
    },

    createOrder(data, actions) {
      return actions.order.create({
        purchase_units: [{
          description: `${CONFIG.STORE_NAME} — ${planName}${quantity > 1 ? ` × ${quantity}` : ""}`,
          amount: {
            currency_code: CONFIG.CURRENCY,
            value: (finalPrice * quantity).toFixed(2),
          },
        }],
        application_context: {
          brand_name: CONFIG.STORE_NAME,
          shipping_preference: "NO_SHIPPING",
        },
      });
    },

    async onApprove(data, actions) {
      const email = getEmail();
      const customerName = document.getElementById("customer-name")?.value.trim() || "";
      showProcessing();

      // ── Paso 1: capturar el pago en PayPal ──
      let order;
      try {
        order = await actions.order.capture();
      } catch (captureErr) {
        console.error("[Checkout] Error de captura de pago:", captureErr);
        trackCheckoutError("payment_failed", "payment_declined", false);
        showError(
          "No se pudo procesar tu pago. No se realizó ningún cargo. " +
          "Intenta nuevamente o usa otro método de pago."
        );
        return;
      }

      // ── Paso 2: pago capturado — activar la(s) eSIM(s) en Zendit ──
      try {
        const transactionId = generateTransactionId();

        // Compatibilidad total con el flujo de 1 unidad: si quantity===1,
        // el ID de la unidad es el transactionId tal cual, SIN sufijo —
        // exactamente como funcionaba antes de agregar cantidad múltiple.
        // Solo con quantity>1 se generan sub-IDs (-1, -2, ...).
        const unitIds = quantity === 1
          ? [transactionId]
          : Array.from({ length: quantity }, (_, i) => `${transactionId}-${i + 1}`);

        // Crear cada compra en Zendit. Hasta 2 intentos por unidad — si
        // alguna sigue fallando, se sigue con las demás (no se pierde la
        // venta completa por un solo fallo puntual).
        const failedUnits = [];
        for (const unitId of unitIds) {
          let created = false;
          for (let attempt = 1; attempt <= 2 && !created; attempt++) {
            try {
              await ZenditAPI.purchaseESIM(offerId, unitId, order.id);
              created = true;
            } catch (unitErr) {
              console.error(`[Checkout] Error creando compra Zendit para ${unitId} (intento ${attempt}):`, unitErr);
            }
          }
          if (!created) failedUnits.push(unitId);
        }

        // Si TODAS las unidades fallaron en crearse, es el mismo caso que
        // antes (pago capturado, Zendit no respondió) — mismo mensaje de
        // error de siempre, no seguir a confirmation.html.
        if (failedUnits.length === unitIds.length) {
          throw new Error("No se pudo activar ninguna eSIM en Zendit tras el pago");
        }

        sessionStorage.setItem("ir_order", JSON.stringify({
          transactionId,
          unitIds: unitIds.filter((id) => !failedUnits.includes(id)),
          failedUnitIds: failedUnits, // unidades que ni siquiera se crearon — confirmation.html avisa honestamente
          quantity,
          paypalOrderId: order.id,
          planName,
          planPrice: finalPrice, // precio POR UNIDAD ya con descuento aplicado
          totalPrice: finalPrice * quantity,
          originalPrice: planPrice,
          couponCode: appliedCoupon?.code || null,
          referralCode: appliedReferral?.code || null,
          email,
          customerName,
          offerId,
          destination: planDestination,
          plan_type: planType,
          duration: planDuration,
          data_amount: planDataAmount,
          purchasedAt: new Date().toISOString(),
        }));

        // Registrar uso de código de referido en Supabase
        if (appliedReferral?.code) {
          fetch("/.netlify/functions/referral?action=register-use", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              referral_code: appliedReferral.code,
              buyer_email: email,
              order_id: order.id,
              sale_amount: finalPrice,
            }),
          }).catch(() => {}); // fire and forget
        }

        window.location.href = "confirmation.html";

      } catch (err) {
        console.error("[Checkout] Error:", err);
        trackCheckoutError("checkout_error", "provider_error", true);
        showError(
          "Tu pago fue procesado pero ocurrió un error activando la eSIM. " +
          "Contacta a " + CONFIG.STORE_EMAIL + " con tu comprobante. Error: " + err.message
        );
      }
    },

    onCancel() {
      trackCheckoutError("payment_cancelled", "payment_cancelled", false);
      document.getElementById("checkout-error").style.display = "none";
      document.getElementById("checkout-processing").style.display = "none";
    },

    onError(err) {
      console.error("[PayPal] Error:", err);
      trackCheckoutError("payment_failed", "provider_error", false);
      showError("Error en el procesador de pagos. Intenta nuevamente.");
    },

  }).render("#paypal-button-container");
}

window.addEventListener("scroll", () => {
  document.querySelector(".nav").classList.toggle("scrolled", window.scrollY > 40);
});

// Agregar sección de cupón al checkout HTML dinámicamente
function addCouponSection() {
  const paymentSection = document.getElementById("payment-section");
  if (!paymentSection) return;

  const couponHTML = `
    <div class="coupon-section">
      <label style="display:block;font-size:0.72rem;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:var(--gray-400);margin-bottom:10px;" id="coupon-label">
        ${typeof t === "function" ? (t("coupon_label") || "Código de descuento") : "Código de descuento"}
      </label>
      <div class="coupon-row">
        <input type="text" class="coupon-input" id="coupon-input" placeholder="Código de descuento" maxlength="20" />
        <button class="coupon-btn" id="apply-coupon-btn" onclick="applyCoupon()">
          Aplicar
        </button>
      </div>
      <div class="coupon-success" id="coupon-success"></div>
      <div class="coupon-error" id="coupon-error"></div>
    </div>
  `;

  paymentSection.insertAdjacentHTML("beforebegin", couponHTML);
}

// Init
updateSummary();

window.addEventListener("load", () => {
  addCouponSection();
  if (window.paypal) {
    initPayPal();
  } else {
    const sdk = document.getElementById("paypal-sdk");
    if (sdk) sdk.addEventListener("load", initPayPal);
    else setTimeout(initPayPal, 1000);
  }
});
