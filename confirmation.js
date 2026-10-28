// ============================================================
//  CONFIRMATION.JS — Muestra el QR y envía email automático
// ============================================================

async function loadConfirmation() {
  const loading = document.getElementById("confirmation-loading");
  const content = document.getElementById("confirmation-content");
  const errorDiv = document.getElementById("confirmation-error");

  const raw = sessionStorage.getItem("ir_order");
  if (!raw) {
    loading.style.display = "none";
    errorDiv.style.display = "block";
    document.getElementById("conf-error-msg").textContent =
      typeof t === "function" ? t("conf_no_order") : "No se encontraron datos de tu pedido.";
    return;
  }

  const order = JSON.parse(raw);
  // Compatibilidad: pedidos de 1 unidad (formato de antes de esta función)
  // no tienen unitIds/quantity — se completan aquí sin cambiar nada más.
  if (!order.unitIds) order.unitIds = [order.transactionId];
  if (!order.quantity) order.quantity = order.unitIds.length;

  // GA4 ecommerce event: purchase
  // Se dispara una sola vez al cargar confirmation.html con un pedido
  // válido en sessionStorage (que solo existe tras un pago exitoso en
  // checkout.js). No altera ninguna variable ni lógica de la orden.
  // Guard anti-duplicado: evita re-disparar purchase si el usuario
  // recarga confirmation.html (sessionStorage persiste entre recargas).
  // El transactionId se usa como event_id compartido entre GA4, el Pixel
  // de Meta y Conversions API — así Meta deduplica automáticamente si
  // ambas rutas (navegador + servidor) llegan a enviarse.
  const gaTrackedKey = `ir_ga_purchase_tracked_${order.transactionId}`;
  if (order.transactionId && !sessionStorage.getItem(gaTrackedKey)) {
    const utms = (typeof getStoredUTMs === "function") ? getStoredUTMs() : {};
    const eventId = order.transactionId; // estable y único: sirve como event_id

    if (typeof gtag === "function") {
      gtag("event", "purchase", {
        transaction_id: order.transactionId,
        currency: "USD",
        value: order.planPrice,
        items: [{
          item_id: order.offerId || "",
          item_name: order.planName,
          price: order.planPrice,
          quantity: 1
        }],
        destination: order.destination || "",
        plan_type: order.plan_type || "",
        duration: order.duration || 0,
        data_amount: order.data_amount || "",
        utm_source: utms.utm_source, utm_medium: utms.utm_medium,
        utm_campaign: utms.utm_campaign, utm_content: utms.utm_content,
      });
    }
    // Meta Pixel: Purchase
    if (typeof fbq === "function") {
      fbq("track", "Purchase", {
        content_ids: [order.offerId || ""],
        content_name: order.planName,
        value: order.planPrice,
        currency: "USD",
      }, { eventID: eventId });
    }
    // Meta Conversions API (server-side) — mismo event_id => deduplicado
    if (typeof sendToCAPI === "function") {
      sendToCAPI("Purchase", eventId, {
        content_ids: [order.offerId || ""],
        content_name: order.planName,
        value: order.planPrice,
        currency: "USD",
      }, order.email);
    }
    window.debugAnalytics && window.debugAnalytics("GA4+Meta", "purchase / Purchase", { transactionId: order.transactionId, value: order.planPrice });

    // TRACKING: Clarity custom tags "TransactionID" y "destination" — permiten
    // encontrar en Clarity (Filters → Custom tags) la grabación exacta de esta
    // compra específica. Nombre "TransactionID" coincide con la convención
    // oficial documentada por Microsoft Clarity. No es PII.
    if (typeof clarity === "function") {
      clarity("set", "TransactionID", order.transactionId);
      if (order.destination) clarity("set", "destination", order.destination);
    }

    sessionStorage.setItem(gaTrackedKey, "1");
  }

  // Guardar precio en localStorage para recuperarlo desde my-esim.html
  try {
    const priceKey = `ir_price_${order.transactionId}`;
    localStorage.setItem(priceKey, JSON.stringify({
      price: order.planPrice,
      planName: order.planName,
      email: order.email
    }));
  } catch(e) {}

  document.getElementById("conf-email").textContent = order.email;
  document.getElementById("conf-plan-name").textContent = order.planName;
  document.getElementById("conf-plan-detail").textContent = order.quantity > 1
    ? `${order.quantity} × ${formatPrice(order.planPrice)} USD c/u — ${formatPrice(order.totalPrice || order.planPrice * order.quantity)} USD total`
    : formatPrice(order.planPrice) + " USD";
  document.getElementById("conf-tx-id").textContent = order.transactionId;

  if (order.failedUnitIds && order.failedUnitIds.length) {
    const warn = document.createElement("div");
    warn.className = "qr-multi-partial-warning";
    warn.textContent = `⚠️ Logramos activar ${order.unitIds.length} de ${order.quantity} eSIMs. La(s) restante(s) no se pudo(eron) generar — contáctanos por WhatsApp con tu ID de transacción (${order.transactionId}) y te ayudamos de inmediato, sin costo adicional.`;
    document.querySelector(".qr-card")?.insertBefore(warn, document.querySelector(".qr-display"));
  }

  loading.style.display = "none";
  content.style.display = "block";

  await loadQRCode(order);
}

// Intenta obtener QR/código de activación para UNA unidad (un transactionId
// o sub-ID). Mismo presupuesto de reintento que siempre: 15 intentos x 6s
// (~90s). Reutilizable tanto para compras de 1 como de varias unidades.
async function pollUnitQR(unitId) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let attempts = 0;
  const maxAttempts = 15;

  while (attempts < maxAttempts) {
    try {
      attempts++;
      console.log(`[QR:${unitId}] Intento ${attempts} de ${maxAttempts}...`);

      const data = await ZenditAPI.getQRCode(unitId);

      const qrBase64 =
        data.imageBase64 || data.qrCode || data.image || data.qr || data.qrImage || data.base64 ||
        (data.esim && data.esim.imageBase64) || (data.data && data.data.imageBase64) || null;

      const activationCode =
        (data.confirmation && data.confirmation.activationCode) ||
        data.activationCode || data.manualCode ||
        (data.esim && data.esim.activationCode) || null;

      const smdpAddress =
        (data.confirmation && data.confirmation.smdpAddress) ||
        data.smdpAddress || data.smDpAddress ||
        (data.esim && data.esim.smdpAddress) || null;

      if (qrBase64 || (activationCode && attempts >= 3)) {
        return { unitId, qrBase64: qrBase64 || null, activationCode: activationCode || null, smdpAddress: smdpAddress || null };
      }

      if (attempts < maxAttempts) await delay(6000);
    } catch (err) {
      console.error(`[QR:${unitId}] Error intento ${attempts}:`, err);
      if (attempts < maxAttempts) await delay(6000);
    }
  }
  return { unitId, qrBase64: null, activationCode: null, smdpAddress: null };
}

async function loadQRCode(order) {
  if (order.quantity > 1) return loadQRCodeMulti(order);
  return loadQRCodeSingle(order);
}

// Camino de 1 unidad — exactamente el mismo comportamiento y elementos del
// DOM que ya funcionaban antes de agregar cantidad múltiple.
async function loadQRCodeSingle(order) {
  const qrLoading = document.getElementById("qr-loading");
  const qrImage = document.getElementById("qr-image");
  const qrError = document.getElementById("qr-error");

  const result = await pollUnitQR(order.unitIds[0]);

  if (result.qrBase64) {
    const qrSrc = `data:image/png;base64,${result.qrBase64}`;
    qrImage.src = qrSrc;
    qrImage.style.display = "block";
    qrLoading.style.display = "none";
    setupDownload(qrSrc, order.transactionId);
    if (result.activationCode) showManualCode(result.activationCode, result.smdpAddress);
    await sendConfirmationEmail(order, [result]);
    return;
  }

  if (result.activationCode) {
    qrLoading.style.display = "none";
    showManualCode(result.activationCode, result.smdpAddress);
    await sendConfirmationEmail(order, [result]);
    return;
  }

  qrLoading.style.display = "none";
  qrError.style.display = "block";
  await sendConfirmationEmail(order, [result]);
  await markOrderPending(order, order.unitIds[0]);
}

// Camino de N unidades (2-5) — todas las llamadas a Zendit en PARALELO,
// así esperar 3 eSIMs no tarda ~3 veces más que esperar 1.
async function loadQRCodeMulti(order) {
  document.querySelector(".qr-display").style.display = "none";
  const multiEl = document.getElementById("qr-multi-display");
  multiEl.style.display = "block";
  multiEl.innerHTML = `
    <p class="qr-multi-summary">Generando ${order.quantity} eSIMs...</p>
    <div class="qr-multi-grid">
      ${order.unitIds.map((id, i) => `
        <div class="qr-multi-item" id="qr-multi-item-${i}">
          <div class="qr-multi-item-label">eSIM ${i + 1} de ${order.quantity}</div>
          <div class="qr-loading"><div class="spinner"></div></div>
        </div>`).join("")}
    </div>`;

  const results = await Promise.all(order.unitIds.map((id) => pollUnitQR(id)));

  results.forEach((result, i) => {
    const item = document.getElementById(`qr-multi-item-${i}`);
    if (!item) return;
    if (result.qrBase64) {
      const qrSrc = `data:image/png;base64,${result.qrBase64}`;
      item.innerHTML = `
        <div class="qr-multi-item-label">eSIM ${i + 1} de ${order.quantity}</div>
        <img src="${qrSrc}" alt="QR Code ${i + 1}" />
        ${result.activationCode ? `<div class="qr-multi-code">Código: ${result.activationCode}</div>` : ""}
        <div class="qr-multi-code">ID: ${result.unitId}</div>
        <button type="button" class="qr-multi-download" data-src="${qrSrc}" data-idx="${i + 1}">⬇️ Descargar</button>`;
    } else if (result.activationCode) {
      item.innerHTML = `
        <div class="qr-multi-item-label">eSIM ${i + 1} de ${order.quantity}</div>
        <div class="qr-error"><p>Código de activación manual:</p></div>
        <div class="qr-multi-code">${result.activationCode}${result.smdpAddress ? ` · SM-DP+: ${result.smdpAddress}` : ""}</div>
        <div class="qr-multi-code">ID: ${result.unitId}</div>`;
    } else {
      item.innerHTML = `
        <div class="qr-multi-item-label">eSIM ${i + 1} de ${order.quantity}</div>
        <div class="qr-error"><p data-i18n="conf_qr_error">No se pudo cargar el QR. Revisa tu email.</p></div>`;
    }
  });

  multiEl.querySelector(".qr-multi-summary").remove();
  multiEl.querySelectorAll(".qr-multi-download").forEach((btn) => {
    btn.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = btn.dataset.src;
      a.download = `infinityroam-esim-${order.transactionId}-${btn.dataset.idx}.png`;
      a.click();
    });
  });

  await sendConfirmationEmail(order, results);

  // Unidades que se crearon en Zendit pero nunca devolvieron QR/código —
  // se registran para reintento automático igual que en el flujo de 1.
  const unresolved = results.filter((r) => !r.qrBase64 && !r.activationCode);
  for (const r of unresolved) {
    await markOrderPending(order, r.unitId);
  }
}

// Registra la orden para que retry-pending-esims.js (función programada,
// corre cada 5 min) siga intentando obtener el QR/código de Zendit en
// segundo plano y reenvíe el correo cuando esté listo. Fire-and-forget:
// cualquier fallo aquí se ignora silenciosamente — nunca debe interrumpir
// ni mostrar error al cliente, que ya vio la página de confirmación.
async function markOrderPending(order, unitId) {
  try {
    await fetch("/.netlify/functions/pending-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId: unitId || order.transactionId,
        email: order.email,
        customerName: order.customerName,
        planName: order.planName,
        planPrice: order.planPrice,
        offerId: order.offerId,
      }),
    });
    console.log(`[QR] Unidad ${unitId || order.transactionId} registrada para reintento automático`);
  } catch (err) {
    console.warn("[QR] No se pudo registrar la orden para reintento (no crítico):", err.message);
  }
}

function showManualCode(activationCode, smdpAddress) {
  let el = document.getElementById("manual-code-section");
  if (!el) {
    el = document.createElement("div");
    el.id = "manual-code-section";
    el.style.cssText = "margin-top:16px;padding:16px;background:#f5f5f5;border-radius:12px;font-size:0.82rem;";
    document.getElementById("qr-image")?.parentElement?.appendChild(el);
  }
  el.innerHTML = `
    <p style="font-weight:600;margin-bottom:8px;">📱 Código de activación manual:</p>
    ${smdpAddress ? `<p style="color:#666;">SM-DP+: <code style="background:#e0e0e0;padding:2px 6px;border-radius:4px;">${smdpAddress}</code></p>` : ""}
    <p>Código: <code style="background:#e0e0e0;padding:2px 6px;border-radius:4px;word-break:break-all;">${activationCode}</code></p>
  `;
}

// Arma el bloque HTML con TODOS los QR/códigos — se arma aquí (no en la
// plantilla) por la misma razón que china_notice: EmailJS no soporta loops
// ni condicionales tipo Handlebars. Se pasa como UNA variable con llaves
// triples {{{qr_codes_block}}} para que EmailJS la inserte tal cual.
function buildQRCodesBlock(results, quantity) {
  return results.map((r, i) => {
    const label = quantity > 1 ? `eSIM ${i + 1} de ${quantity}` : "";
    const qrHtml = r.qrBase64
      ? `<img src="https://infinity-roam.com/.netlify/functions/qr-image?id=${r.unitId}" alt="QR Code" width="180" height="180" style="display:block;border-radius:12px;margin:0 auto 10px;" />`
      : "";
    const codeHtml = r.activationCode
      ? `<p style="font-size:12px;color:#888;margin:0 0 2px;">Código de activación</p>
         <p style="font-size:13px;font-weight:bold;color:#000;word-break:break-all;font-family:monospace;margin:0 0 10px;">${r.activationCode}</p>`
      : "";
    const smdpHtml = r.smdpAddress
      ? `<p style="font-size:12px;color:#888;margin:0 0 2px;">Dirección SM-DP+</p>
         <p style="font-size:13px;font-weight:bold;color:#000;word-break:break-all;font-family:monospace;margin:0;">${r.smdpAddress}</p>`
      : "";
    if (!qrHtml && !codeHtml) return ""; // unidad sin datos aún — el reintento automático se encarga
    return `
      <table style="background:#f5f5f7;border-radius:12px;padding:20px;margin:0 0 16px;width:100%;" cellspacing="0" cellpadding="0">
        <tr><td style="text-align:center;">
          ${label ? `<p style="font-size:13px;font-weight:bold;color:#000;margin:0 0 12px;">${label}</p>` : ""}
          ${qrHtml}
          ${codeHtml}
          ${smdpHtml}
        </td></tr>
      </table>`;
  }).join("");
}

async function sendConfirmationEmail(order, results) {
  try {
    if (!order.email) {
      console.log("[Email] Sin email — saltando envío");
      return;
    }

    const recoveryUrl = `https://infinity-roam.com/my-esim.html?id=${order.transactionId}`;
    const isChinaPlan = order.offerId && order.offerId.includes("-CN-");
    const first = results[0] || {};

    const payload = {
      to_email: order.email,
      to_name: order.customerName || order.email.split("@")[0],
      subject: isChinaPlan
        ? "¡Tu eSIM para China está lista! Instálala ANTES de llegar — Infinity Roam"
        : (order.quantity > 1 ? `¡Tus ${order.quantity} eSIMs están listas! — Infinity Roam` : "¡Tu eSIM está lista! — Infinity Roam"),
      order_id: order.transactionId,
      plan_name: order.planName,
      plan_price: formatPrice(order.planPrice) + " USD",
      quantity: order.quantity || 1,
      total_price: formatPrice(order.totalPrice || order.planPrice * (order.quantity || 1)) + " USD",
      transaction_id: order.transactionId,
      recovery_url: recoveryUrl,
      qr_image: "",
      // Compatibilidad hacia atrás: si la plantilla en EmailJS todavía NO
      // tiene el bloque {{{qr_codes_block}}} agregado, el correo sigue
      // mostrando el código de la PRIMERA unidad en los campos de siempre
      // — así no se rompe nada mientras se actualiza la plantilla.
      activation_code: first.activationCode || "",
      smdp_address: first.smdpAddress || "",
      // Bloque nuevo con TODAS las unidades — requiere agregar
      // {{{qr_codes_block}}} en la plantilla de EmailJS (ver instrucciones).
      // Solo se arma el bloque de múltiples QR cuando hay 2+ unidades — para
      // 1 sola unidad, el <img> original de la plantilla (con {{transaction_id}})
      // ya muestra el QR; generar también qr_codes_block lo duplicaría.
      qr_codes_block: (order.quantity || 1) > 1 ? buildQRCodesBlock(results, order.quantity) : "",
      china_notice: isChinaPlan
        ? '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:10px;padding:16px;margin:0 0 20px;font-size:14px;color:#856404;">⚠️ IMPORTANTE: Instala y activa tu eSIM ANTES de llegar a China. Una vez dentro del país no podrás descargar la app ni acceder al QR por internet. Tu eSIM te dará acceso a WhatsApp, Google, Instagram y YouTube sin restricciones gracias al enrutamiento internacional.</div>'
        : "",
    };

    console.log("[Email] Enviando a:", order.email, "— unidades:", results.length);
    const response = await fetch("/.netlify/functions/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (result.ok) {
      console.log("[Email] Enviado exitosamente");
    } else {
      console.error("[Email] Error:", result.error);
    }

  } catch (err) {
    console.error("[Email] Error enviando:", err);
  }
}

function setupDownload(qrSrc, transactionId) {
  const btn = document.getElementById("download-qr-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = qrSrc;
      a.download = `infinityroam-esim-${transactionId}.png`;
      a.click();
    });
  }
}

// Tabs iOS/Android
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

loadConfirmation();
