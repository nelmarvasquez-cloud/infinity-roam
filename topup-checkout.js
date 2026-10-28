// ============================================================
//  TOPUP-CHECKOUT.JS — Pago del envío de saldo (Mobile Top-Up)
// ============================================================
// Aislado por completo del checkout.js de eSIM — comparte el mismo
// patrón de integración con PayPal, pero es su propio archivo para
// no arriesgar el flujo de pago de eSIM ya en producción.
//
// REGLA DE NEGOCIO: el programa de referidos (descuento al comprador +
// comisión al referido) aplica SOLO a compras de eSIM de datos, NUNCA
// a envíos de saldo. Por eso este checkout no tiene campo de cupón/
// código de referido ni llama a referral?action=register-use — si en
// el futuro alguien quiere agregar descuentos aquí, debe ser un
// mecanismo separado, no reutilizar el de referidos de eSIM.

const params = new URLSearchParams(window.location.search);
const offerId = params.get("offerId");
const price = parseFloat(params.get("price") || "0");
const brand = params.get("brand") || "";
const countryName = params.get("country") || "";
const recipientPhone = params.get("recipientPhone") || "";
const senderEmail = params.get("senderEmail") || "";

function generateTopupTransactionId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `IR-TU-${timestamp}-${random}`;
}

function renderSummary() {
  document.getElementById("co-brand").textContent = brand || "—";
  document.getElementById("co-country").textContent = countryName || "—";
  document.getElementById("co-phone").textContent = recipientPhone || "—";
  document.getElementById("co-price").textContent = `$${price.toFixed(2)} USD`;
}

function showError(msg) {
  const el = document.getElementById("topup-co-error");
  el.textContent = msg;
  el.style.display = "block";
}

function initPayPal() {
  if (!window.paypal) {
    setTimeout(initPayPal, 500);
    return;
  }
  const container = document.getElementById("topup-paypal-container");
  if (!container) return;

  if (!offerId || !price || !recipientPhone || !senderEmail) {
    showError("Faltan datos del envío. Vuelve a la página anterior e inténtalo de nuevo.");
    return;
  }

  paypal.Buttons({
    style: { layout: "vertical", color: "black", shape: "rect", label: "pay", height: 48 },

    createOrder(data, actions) {
      return actions.order.create({
        purchase_units: [{
          description: `${CONFIG.STORE_NAME} — Envío de saldo a ${countryName}`,
          amount: { currency_code: CONFIG.CURRENCY, value: price.toFixed(2) },
        }],
        application_context: { brand_name: CONFIG.STORE_NAME, shipping_preference: "NO_SHIPPING" },
      });
    },

    async onApprove(data, actions) {
      document.getElementById("topup-paypal-container").style.display = "none";
      document.getElementById("topup-co-processing").style.display = "block";

      try {
        const order = await actions.order.capture();
        const transactionId = generateTopupTransactionId();

        const result = await ZenditAPI.purchaseTopup(offerId, recipientPhone, transactionId);

        // Registrar el pedido ANTES de redirigir — el webhook de Zendit
        // (topup-webhook.js) necesita encontrar esta fila para saber a
        // quién enviarle la confirmación cuando la recarga se complete.
        try {
          await fetch("/.netlify/functions/topup-order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transactionId, senderEmail, recipientPhone, brand, country: countryName, price }),
          });
        } catch (logErr) {
          console.warn("[Topup Checkout] No se pudo registrar el pedido (no crítico, pero el correo de confirmación podría no llegar):", logErr.message);
        }

        sessionStorage.setItem("ir_topup_order", JSON.stringify({
          transactionId,
          paypalOrderId: order.id,
          offerId,
          brand,
          country: countryName,
          recipientPhone,
          senderEmail,
          price,
          purchasedAt: new Date().toISOString(),
          initialStatus: result.status || "PENDING",
        }));

        window.location.href = "topup-confirmation.html";

      } catch (err) {
        console.error("[Topup Checkout] Error tras el pago:", err);
        document.getElementById("topup-co-processing").style.display = "none";
        document.getElementById("topup-paypal-container").style.display = "block";
        showError("Tu pago se procesó, pero hubo un problema activando la recarga. Contáctanos por WhatsApp con este ID: " + Date.now());
      }
    },

    onError(err) {
      console.error("[Topup Checkout] Error de PayPal:", err);
      showError("Hubo un problema procesando el pago. Intenta de nuevo.");
    },
  }).render("#topup-paypal-container");
}

document.addEventListener("DOMContentLoaded", () => {
  renderSummary();
  if (window.paypal) {
    initPayPal();
  } else {
    const sdk = document.getElementById("paypal-sdk");
    if (sdk) sdk.addEventListener("load", initPayPal);
    else setTimeout(initPayPal, 1000);
  }

  const lt = document.getElementById("lang-toggle");
  // El toggle de idioma ya está manejado globalmente por i18n.js.
});
