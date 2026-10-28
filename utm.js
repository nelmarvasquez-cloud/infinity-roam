// ============================================================
//  UTM.JS — Atribución de campañas + deduplicación de eventos
//  Compartido por todas las páginas públicas. No toca lógica
//  de negocio (Zendit/PayPal/referidos/checkout).
// ============================================================

(function () {
  var STORAGE_KEY = "ir_utm";
  var DEBUG_KEY = "ir_debug_analytics";

  // ── 1. Activar/desactivar modo debug vía ?debug_analytics=1 ──
  var params = new URLSearchParams(window.location.search);
  if (params.get("debug_analytics") === "1") {
    localStorage.setItem(DEBUG_KEY, "1");
  } else if (params.get("debug_analytics") === "0") {
    localStorage.removeItem(DEBUG_KEY);
  }

  function isDebugOn() {
    return localStorage.getItem(DEBUG_KEY) === "1";
  }

  // ── 2. Capturar UTMs si están presentes en la URL de aterrizaje ──
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  var hasNewUTM = UTM_KEYS.some(function (k) { return params.has(k); });

  if (hasNewUTM) {
    var utmData = {};
    UTM_KEYS.forEach(function (k) {
      if (params.has(k)) utmData[k] = params.get(k);
    });
    utmData.landing_page = window.location.pathname;
    utmData.captured_at = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(utmData));
  }

  // ── 3. Helper público: obtener los UTMs guardados (o {} si no hay) ──
  window.getStoredUTMs = function () {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  };

  // ── 4. Generador de event_id compartido entre Pixel y Conversions API ──
  // Mismo event_id en fbq() y en la llamada server-side = Meta deduplica
  // automáticamente y no cuenta la conversión dos veces.
  window.generateEventId = function (prefix) {
    var rand = Math.random().toString(36).slice(2, 10);
    var ts = Date.now();
    return (prefix || "ev") + "_" + ts + "_" + rand;
  };

  // ── 5. Logger de depuración — visible en consola con ?debug_analytics=1 ──
  window.debugAnalytics = function (channel, eventName, params) {
    if (!isDebugOn()) return;
    console.log(
      "%c[" + channel + "] " + eventName,
      "color:#2864E6;font-weight:700",
      params || {}
    );
  };

  if (isDebugOn()) {
    console.log("%c[Analytics Debug Mode ON]", "color:#F5A623;font-weight:700",
      "Añade ?debug_analytics=0 a la URL para desactivarlo.");
  }

  // ── 6. Meta Pixel — inicialización base ──
  // El Pixel ID se obtiene de una variable de entorno en Netlify
  // (META_PIXEL_ID), igual que PAYPAL_CLIENT_ID. Si no está configurado
  // todavía, el Pixel simplemente no se carga (no rompe nada).
  window.metaPixelReady = fetch("/.netlify/functions/get-config")
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (js) {
      if (js) {
        try { eval(js); } catch (e) {}
      }
      var pixelId = (window.IR_RUNTIME_CONFIG && window.IR_RUNTIME_CONFIG.META_PIXEL_ID) || "";
      if (!pixelId) {
        window.debugAnalytics && window.debugAnalytics("Meta", "Pixel no configurado (falta META_PIXEL_ID)", {});
        return false;
      }
      !function (f, b, e, v, n, t, s) {
        if (f.fbq) return;
        n = f.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n;
        n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
        t = b.createElement(e); t.async = !0; t.src = v;
        s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
      }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");

      fbq("init", pixelId);
      fbq("track", "PageView");
      window.debugAnalytics && window.debugAnalytics("Meta", "PageView", { pixel_id: pixelId });
      return true;
    })
    .catch(function () { return false; });

  // ── Microsoft Clarity ──
  // Reutiliza el mismo window.IR_RUNTIME_CONFIG ya cargado arriba (evita un
  // segundo fetch a get-config). Si CLARITY_PROJECT_ID no está configurado,
  // simplemente no se activa — no rompe nada.
  window.metaPixelReady.then(function () {
    var clarityId = (window.IR_RUNTIME_CONFIG && window.IR_RUNTIME_CONFIG.CLARITY_PROJECT_ID) || "";
    if (!clarityId) {
      window.debugAnalytics && window.debugAnalytics("Clarity", "No configurado (falta CLARITY_PROJECT_ID)", {});
      return;
    }
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", clarityId);

    // Tags no-PII para correlacionar sesiones de Clarity con hallazgos de GA4
    // (ver ANALYTICS_README.md sección de correlación GA4+Clarity).
    var utmsForClarity = window.getStoredUTMs ? window.getStoredUTMs() : {};
    if (window.clarity) {
      if (utmsForClarity.utm_campaign) window.clarity("set", "utm_campaign", utmsForClarity.utm_campaign);
      if (utmsForClarity.utm_source) window.clarity("set", "utm_source", utmsForClarity.utm_source);
    }
    window.debugAnalytics && window.debugAnalytics("Clarity", "Inicializado", { project_id: clarityId });
  });

  // ── 7. Helper: enviar evento a Meta Conversions API (server-side) ──
  // Fire-and-forget: nunca bloquea ni rompe la página si falla.
  window.sendToCAPI = function (eventName, eventId, customData, email) {
    try {
      fetch("/.netlify/functions/meta-capi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_name: eventName,
          event_id: eventId,
          event_source_url: window.location.href,
          custom_data: customData || {},
          email: email || undefined,
        }),
      }).catch(function () {});
    } catch (e) {}
  };
})();
