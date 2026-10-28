// ============================================================
//  INFINITY ROAM — CONFIGURACIÓN PRODUCCIÓN
//  Claves sensibles se cargan desde Netlify env vars en runtime
// ============================================================

const CONFIG = {
  // --- ZENDIT PRODUCCIÓN ---
  ZENDIT_SANDBOX: false,

  // --- PAYPAL LIVE ---
  PAYPAL_CLIENT_ID: "PENDING",
  PAYPAL_MODE: "live",

  // --- TIENDA ---
  STORE_NAME: "Infinity Roam",
  STORE_EMAIL: "sales@infinity-roam.com",
  CURRENCY: "USD",
  MARKUP: 1.5,
  PLANS_PER_PAGE: 12,

  // --- WHATSAPP ---
  WHATSAPP_NUMBER: "50765663686",
  WHATSAPP_MESSAGE: "Hola! Me gustaría obtener información sobre los servicios de Infinity Roam (eSIM y recargas).",

  // --- EMAILJS ---
  EMAILJS_PUBLIC_KEY: "PENDING",
  EMAILJS_SERVICE_ID: "",
  EMAILJS_TEMPLATE_ID: "",
};

// Cargar claves desde Netlify en runtime (evita hardcodear secrets)
(async function loadRuntimeConfig() {
  try {
    const r = await fetch("/.netlify/functions/get-config");
    if (r.ok) {
      const js = await r.text();
      // eslint-disable-next-line no-eval
      eval(js);
      if (window.IR_RUNTIME_CONFIG) {
        if (window.IR_RUNTIME_CONFIG.PAYPAL_CLIENT_ID) CONFIG.PAYPAL_CLIENT_ID = window.IR_RUNTIME_CONFIG.PAYPAL_CLIENT_ID;
        if (window.IR_RUNTIME_CONFIG.EMAILJS_PUBLIC_KEY) CONFIG.EMAILJS_PUBLIC_KEY = window.IR_RUNTIME_CONFIG.EMAILJS_PUBLIC_KEY;
      }
    }
  } catch(e) {
    console.warn("[Config] No se pudo cargar config runtime:", e.message);
  }
})();

const ZENDIT_BASE = "https://api.zendit.io/v1";
