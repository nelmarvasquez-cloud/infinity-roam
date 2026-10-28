// ============================================================
//  METRICS-ENGINE.JS — Capa 3: cálculos de negocio
//  Funciones puras: reciben datos ya normalizados y devuelven
//  métricas listas para el dashboard. No conocen GA4 ni HTTP.
// ============================================================

// ── Comparación entre período actual y anterior ──
function periodVariation(current, previous) {
  if (!previous || previous === 0) {
    return current > 0 ? { pct: null, label: "N/A (sin dato previo)" } : { pct: 0, label: "0%" };
  }
  const pct = ((current - previous) / previous) * 100;
  return { pct: Math.round(pct * 10) / 10, label: `${pct >= 0 ? "+" : ""}${Math.round(pct * 10) / 10}%` };
}

// ── Embudo principal ──
// funnelCounts: { sessions, view_item, select_plan, add_to_cart, begin_checkout, purchase }
// (ver documentación: sessions = sesiones; el resto = usuarios únicos que
// dispararon ese evento — nunca se mezcla con conteo bruto de eventos)
const FUNNEL_STEPS = [
  { key: "sessions", label: "Sesiones", metric: "sessions" },
  { key: "view_item", label: "Vieron un producto", metric: "usuarios únicos" },
  { key: "select_plan", label: "Seleccionaron un plan", metric: "usuarios únicos" },
  { key: "add_to_cart", label: "Agregaron al carrito", metric: "usuarios únicos" },
  { key: "begin_checkout", label: "Iniciaron checkout", metric: "usuarios únicos" },
  { key: "purchase", label: "Compraron", metric: "usuarios únicos" },
];

// FASE 2 — recorrido completo (sección 9 del pedido: "USER JOURNEY").
// Mismos principios que FUNNEL_STEPS (usuarios únicos, nunca event_count),
// extendido con las 2 etapas de exploración previas a ver un producto.
const JOURNEY_STEPS = [
  { key: "sessions", label: "Sesiones", metric: "sessions" },
  { key: "search_destination", label: "Buscaron un destino", metric: "usuarios únicos" },
  { key: "view_destination", label: "Vieron resultados de destino", metric: "usuarios únicos" },
  { key: "view_item", label: "Vieron un producto", metric: "usuarios únicos" },
  { key: "select_plan", label: "Seleccionaron un plan", metric: "usuarios únicos" },
  { key: "add_to_cart", label: "Agregaron al carrito", metric: "usuarios únicos" },
  { key: "begin_checkout", label: "Iniciaron checkout", metric: "usuarios únicos" },
  { key: "purchase", label: "Compraron", metric: "usuarios únicos" },
];

// steps es opcional — por defecto usa FUNNEL_STEPS, exactamente el mismo
// comportamiento que antes. Los llamados existentes (computeFunnel(counts))
// no cambian en absoluto; solo se habilita pasar un embudo distinto (ej.
// JOURNEY_STEPS) sin duplicar esta función.
function computeFunnel(counts, steps) {
  const stepsToUse = steps || FUNNEL_STEPS;
  const base = counts.sessions || 0;
  let prev = null;
  return stepsToUse.map((step) => {
    const value = counts[step.key] || 0;
    const stepConversionPct = prev !== null && prev > 0 ? Math.round((value / prev) * 1000) / 10 : null;
    const dropOffPct = stepConversionPct !== null ? Math.round((100 - stepConversionPct) * 10) / 10 : null;
    const cumulativePct = base > 0 ? Math.round((value / base) * 1000) / 10 : 0;
    prev = value;
    return {
      key: step.key,
      label: step.label,
      metric_used: step.metric,
      value,
      step_conversion_pct: stepConversionPct, // % que avanzó desde el paso anterior
      drop_off_pct: dropOffPct,               // % que se perdió desde el paso anterior
      cumulative_conversion_pct: cumulativePct, // % acumulado desde Sessions
    };
  });
}

// ── Módulo de abandono (Conversion Drop-off) ──
// Deriva directamente del embudo — no requiere una consulta nueva a GA4.
function computeDropOff(funnelCurrent, funnelPrevious) {
  const rows = [];
  for (let i = 0; i < funnelCurrent.length - 1; i++) {
    const from = funnelCurrent[i];
    const to = funnelCurrent[i + 1];
    const lost = Math.max(from.value - to.value, 0);
    const lostPct = from.value > 0 ? Math.round((lost / from.value) * 1000) / 10 : 0;

    let prevLostPct = null;
    if (funnelPrevious) {
      const pFrom = funnelPrevious[i];
      const pTo = funnelPrevious[i + 1];
      if (pFrom && pTo && pFrom.value > 0) {
        prevLostPct = Math.round(((pFrom.value - pTo.value) / pFrom.value) * 1000) / 10;
      }
    }

    rows.push({
      from: from.label,
      to: to.label,
      users_lost: lost,
      drop_off_pct: lostPct,
      previous_period_pct: prevLostPct,
      variation: prevLostPct !== null ? Math.round((lostPct - prevLostPct) * 10) / 10 : null,
    });
  }
  // Identificar automáticamente el mayor punto de abandono
  const worst = rows.reduce((max, r) => (r.drop_off_pct > (max?.drop_off_pct ?? -1) ? r : max), null);
  return { steps: rows, biggest_drop_off: worst };
}

// ── AOV (Average Order Value) ──
function computeAOV(revenue, purchases) {
  return purchases > 0 ? Math.round((revenue / purchases) * 100) / 100 : 0;
}

// ── Insights determinísticos (reglas fijas, sin IA) ──
function computeInsights({ funnelCurrent, funnelPrevious, sessionsVariation, purchasesVariation, campaigns, destinations, deviceBreakdown, journeyFunnel, checkoutAnalytics }) {
  const insights = [];

  // Regla 1: tráfico sube pero compras bajan
  if (sessionsVariation?.pct != null && purchasesVariation?.pct != null) {
    if (sessionsVariation.pct > 10 && purchasesVariation.pct < 0) {
      insights.push({
        type: "warning",
        text: `El tráfico subió ${sessionsVariation.label} pero las compras cayeron ${purchasesVariation.label} respecto al período anterior.`,
      });
    }
  }

  // Regla 2: abandono muy alto en algún paso del embudo (>85%)
  const dropOff = computeDropOff(funnelCurrent, funnelPrevious);
  if (dropOff.biggest_drop_off && dropOff.biggest_drop_off.drop_off_pct >= 85) {
    insights.push({
      type: "critical",
      text: `El abandono entre "${dropOff.biggest_drop_off.from}" y "${dropOff.biggest_drop_off.to}" es de ${dropOff.biggest_drop_off.drop_off_pct}% — es el mayor punto de fuga actual.`,
    });
  }

  // Regla 3: destino(s) con muchas vistas pero conversión casi nula
  // (umbral: >=20 vistas y <1% conversión — ver HIGH_INTEREST_MIN_VIEWS/LOW_CONVERSION_THRESHOLD_PCT)
  if (destinations && destinations.length) {
    const flagged = flagDestinations(destinations).filter((d) => d.high_interest_low_conversion);
    flagged.slice(0, 3).forEach((d) => {
      insights.push({
        type: "warning",
        text: `${d.destination} tiene alto interés (${d.views} vistas) pero conversión de solo ${d.conversion_rate_pct}%.`,
      });
    });
  }

  // Regla 4: campaña con mucho tráfico pero cero compras
  if (campaigns && campaigns.length) {
    const totalSessions = campaigns.reduce((s, c) => s + c.sessions, 0);
    campaigns.forEach((c) => {
      const share = totalSessions > 0 ? (c.sessions / totalSessions) * 100 : 0;
      if (share >= 20 && (c.purchases || 0) === 0 && c.sessions >= 10) {
        insights.push({
          type: "critical",
          text: `La campaña "${c.campaign}" generó ${share.toFixed(0)}% del tráfico pero cero compras.`,
        });
      }
    });
  }

  // Regla 5: conversión móvil vs escritorio (umbral: mobile <60% de la conversión de desktop)
  if (deviceBreakdown && deviceBreakdown.length >= 2) {
    const mobile = deviceBreakdown.find((d) => d.device?.toLowerCase() === "mobile");
    const desktop = deviceBreakdown.find((d) => d.device?.toLowerCase() === "desktop");
    if (mobile && desktop && mobile.sessions > 0 && desktop.sessions > 0) {
      const mobileConv = (mobile.purchases / mobile.sessions) * 100;
      const desktopConv = (desktop.purchases / desktop.sessions) * 100;
      if (desktopConv > 0 && mobileConv < desktopConv * 0.6) {
        insights.push({
          type: "info",
          text: `La conversión en mobile (${mobileConv.toFixed(2)}%) es significativamente menor que en desktop (${desktopConv.toFixed(2)}%).`,
        });
      }
    }
  }

  // Regla 6: checkout con abandono alto específico (además de la regla 2 general)
  const checkoutStep = funnelCurrent.find((f) => f.key === "purchase");
  if (checkoutStep && checkoutStep.drop_off_pct !== null && checkoutStep.drop_off_pct >= 80) {
    insights.push({
      type: "warning",
      text: `El abandono en checkout (antes de completar la compra) es actualmente de ${checkoutStep.drop_off_pct}%.`,
    });
  }

  // ── Reglas nuevas — FASE 2 (sección 14 del pedido) ──

  // Regla 7: mucho tráfico, pocas vistas de producto (umbral: <40% avanza)
  if (journeyFunnel) {
    const sessions = journeyFunnel.find((f) => f.key === "sessions");
    const viewItem = journeyFunnel.find((f) => f.key === "view_item");
    if (sessions && viewItem && sessions.value >= 30 && viewItem.cumulative_conversion_pct < 40) {
      insights.push({
        type: "warning",
        text: `Solo ${viewItem.cumulative_conversion_pct}% de las sesiones llegan a ver un producto — la mayoría no explora el catálogo.`,
      });
    }

    // Regla 8: muchas vistas de producto, poca selección de plan (umbral: <50% avanza en ese paso)
    const selectPlan = journeyFunnel.find((f) => f.key === "select_plan");
    if (viewItem && selectPlan && viewItem.value >= 20 && selectPlan.step_conversion_pct !== null && selectPlan.step_conversion_pct < 50) {
      insights.push({
        type: "warning",
        text: `${100 - selectPlan.step_conversion_pct}% de quienes ven un producto no seleccionan ningún plan.`,
      });
    }

    // Regla 9: mucha selección de plan, poco checkout (umbral: <40% avanza en ese paso)
    const beginCheckoutStep = journeyFunnel.find((f) => f.key === "begin_checkout");
    if (selectPlan && beginCheckoutStep && selectPlan.value >= 10 && beginCheckoutStep.step_conversion_pct !== null && beginCheckoutStep.step_conversion_pct < 40) {
      insights.push({
        type: "warning",
        text: `Solo ${beginCheckoutStep.step_conversion_pct}% de quienes seleccionan un plan inician el checkout.`,
      });
    }
  }

  // Regla 10: fallo de pago alto (umbral: >=15% de begin_checkout termina en fallo técnico)
  if (checkoutAnalytics && checkoutAnalytics.begin_checkout >= 10 && checkoutAnalytics.payment_failure_rate_pct >= 15) {
    insights.push({
      type: "critical",
      text: `${checkoutAnalytics.payment_failure_rate_pct}% de los intentos de checkout terminan en un error de pago (no en abandono) — esto es técnico y accionable.`,
    });
  }

  if (!insights.length) {
    insights.push({ type: "info", text: "No se detectaron alertas relevantes en el período seleccionado con las reglas actuales." });
  }

  return insights;
}

// ── Checkout Analytics (sección 12) — distingue abandono de fallo de pago ──
// Definiciones (documentadas, no umbrales arbitrarios):
//   payment_cancelled = el usuario canceló explícitamente el popup de PayPal
//   payment_failed / checkout_error = intentó pagar y tuvo un problema técnico
//   abandono silencioso = llegó a begin_checkout, no compró, y no generó
//     ninguno de los dos eventos anteriores (simplemente se fue)
//   Checkout Abandonment Rate = (cancelado + abandono silencioso) / begin_checkout
//   Payment Failure Rate = (payment_failed + checkout_error) / begin_checkout
function computeCheckoutAnalytics(counts) {
  const beginCheckout = counts.begin_checkout || 0;
  const purchases = counts.purchase || 0;
  const cancelled = counts.payment_cancelled || 0;
  const failed = (counts.payment_failed || 0) + (counts.checkout_error || 0);
  const silentAbandon = Math.max(beginCheckout - purchases - cancelled - failed, 0);

  const pct = (n) => (beginCheckout > 0 ? Math.round((n / beginCheckout) * 1000) / 10 : 0);

  return {
    begin_checkout: beginCheckout,
    purchases,
    payment_cancelled: cancelled,
    payment_failed: failed,
    silent_abandonment: silentAbandon,
    purchase_rate_pct: pct(purchases),
    checkout_abandonment_rate_pct: pct(cancelled + silentAbandon),
    payment_failure_rate_pct: pct(failed),
  };
}

// ── Flags de destinos: HIGH INTEREST + LOW CONVERSION (sección 10) ──
// Umbral documentado: >= 20 vistas (muestra mínima significativa) y
// conversión (purchases/views) < 1% — mismo umbral ya usado en la regla de
// insights existente, aplicado aquí de forma consistente y explícita.
const HIGH_INTEREST_MIN_VIEWS = 20;
const LOW_CONVERSION_THRESHOLD_PCT = 1;

function flagDestinations(destinations) {
  return destinations.map((d) => {
    const convRate = d.views > 0 ? Math.round((d.purchases / d.views) * 1000) / 10 : 0;
    return {
      ...d,
      conversion_rate_pct: convRate,
      high_interest_low_conversion: d.views >= HIGH_INTEREST_MIN_VIEWS && convRate < LOW_CONVERSION_THRESHOLD_PCT,
    };
  });
}

// ── Panel de diagnóstico (sección 18) — resumen automático ──
function computeDiagnostics({ dropOff, destinations, products, checkoutAnalytics, deviceBreakdown }) {
  const biggestDropOff = dropOff?.biggest_drop_off || null;

  const withViews = (destinations || []).filter((d) => d.views > 0);
  const highestInterest = withViews.length
    ? [...withViews].sort((a, b) => b.views - a.views)[0]
    : null;
  const rated = withViews.filter((d) => d.views >= HIGH_INTEREST_MIN_VIEWS);
  const lowestConverting = rated.length
    ? [...rated].sort((a, b) => a.conversion_rate_pct - b.conversion_rate_pct)[0]
    : null;
  const highestConverting = rated.length
    ? [...rated].sort((a, b) => b.conversion_rate_pct - a.conversion_rate_pct)[0]
    : null;

  const mostViewedProduct = (products || []).length
    ? [...products].sort((a, b) => b.views - a.views)[0]
    : null;
  const bestConvertingProduct = (products || []).filter((p) => p.views >= HIGH_INTEREST_MIN_VIEWS).length
    ? [...products].filter((p) => p.views >= HIGH_INTEREST_MIN_VIEWS).sort((a, b) => b.conversion_rate - a.conversion_rate)[0]
    : null;

  const mobile = (deviceBreakdown || []).find((d) => d.device?.toLowerCase() === "mobile");
  const desktop = (deviceBreakdown || []).find((d) => d.device?.toLowerCase() === "desktop");
  const mobileConvRate = mobile && mobile.sessions > 0 ? Math.round((mobile.purchases / mobile.sessions) * 1000) / 10 : null;
  const desktopConvRate = desktop && desktop.sessions > 0 ? Math.round((desktop.purchases / desktop.sessions) * 1000) / 10 : null;

  return {
    biggest_drop_off: biggestDropOff ? `${biggestDropOff.from} → ${biggestDropOff.to} (${biggestDropOff.drop_off_pct}%)` : "Sin datos suficientes",
    highest_interest_destination: highestInterest ? `${highestInterest.destination} (${highestInterest.views} vistas)` : "Sin datos suficientes",
    lowest_converting_destination: lowestConverting ? `${lowestConverting.destination} (${lowestConverting.conversion_rate_pct}%)` : "Sin datos suficientes",
    highest_converting_destination: highestConverting ? `${highestConverting.destination} (${highestConverting.conversion_rate_pct}%)` : "Sin datos suficientes",
    most_viewed_product: mostViewedProduct ? `${mostViewedProduct.plan_name} (${mostViewedProduct.views} vistas)` : "Sin datos suficientes",
    best_converting_product: bestConvertingProduct ? `${bestConvertingProduct.plan_name} (${bestConvertingProduct.conversion_rate}%)` : "Sin datos suficientes",
    checkout_abandonment_rate: checkoutAnalytics ? `${checkoutAnalytics.checkout_abandonment_rate_pct}%` : "Sin datos suficientes",
    payment_failure_rate: checkoutAnalytics ? `${checkoutAnalytics.payment_failure_rate_pct}%` : "Sin datos suficientes",
    mobile_conversion_rate: mobileConvRate !== null ? `${mobileConvRate}%` : "Sin datos suficientes",
    desktop_conversion_rate: desktopConvRate !== null ? `${desktopConvRate}%` : "Sin datos suficientes",
  };
}

// ── Meta Ads: CPA, CAC, ROAS ──
// CPA = gasto / compras (costo por adquisición de una venta)
// CAC = igual que CPA en este contexto — no se distingue "cliente" de
//   "compra" porque no hay suscripciones/recurrencia, cada venta = 1 cliente
// ROAS = ingresos / gasto (retorno sobre la inversión publicitaria)
function computeMetaAdsMetrics(spend, purchases, revenue) {
  return {
    spend: Math.round(spend * 100) / 100,
    cpa: purchases > 0 ? Math.round((spend / purchases) * 100) / 100 : null,
    cac: purchases > 0 ? Math.round((spend / purchases) * 100) / 100 : null,
    roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null,
  };
}

module.exports = {
  periodVariation,
  computeFunnel,
  computeDropOff,
  computeAOV,
  computeInsights,
  computeCheckoutAnalytics,
  flagDestinations,
  computeDiagnostics,
  computeMetaAdsMetrics,
  FUNNEL_STEPS,
  JOURNEY_STEPS,
  HIGH_INTEREST_MIN_VIEWS,
  LOW_CONVERSION_THRESHOLD_PCT,
};
