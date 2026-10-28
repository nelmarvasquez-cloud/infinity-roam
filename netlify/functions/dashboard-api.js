// ============================================================
//  DASHBOARD-API.JS — Capa 4: API interna del dashboard
//  Único endpoint que consume el frontend. Orquesta las consultas
//  a GA4, aplica filtros, cachea resultados y devuelve todo ya
//  calculado. El frontend NUNCA llama a GA4 directamente.
//
//  Protegido con la misma contraseña de admin que referral.js.
// ============================================================

const ga4 = require("./lib/ga4-client");
const metaAds = require("./lib/meta-ads-client");
const { normalizeReport, normalizeSingleRow, classifyChannel } = require("./lib/normalize");
const {
  computeMetaAdsMetrics,
  computeFunnel,
  computeDropOff,
  computeAOV,
  computeInsights,
  computeCheckoutAnalytics,
  flagDestinations,
  computeDiagnostics,
  periodVariation,
  JOURNEY_STEPS,
} = require("./lib/metrics-engine");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD; // acceso separado, ej. para el/la CM
const FUNNEL_EVENTS = ["view_item", "select_plan", "add_to_cart", "begin_checkout", "purchase"];
// FASE 2 — recorrido completo (incluye exploración del catálogo)
const JOURNEY_EVENTS = ["search_destination", "view_destination", ...FUNNEL_EVENTS];
// FASE 2 — estados de checkout (distinguir abandono de fallo técnico)
const CHECKOUT_EVENTS = ["begin_checkout", "payment_cancelled", "payment_failed", "checkout_error", "purchase"];
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ── Caché en memoria (vive mientras la función esté "caliente" en Netlify) ──
const _cache = new Map();
function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit || Date.now() > hit.expiresAt) return null;
  return hit.value;
}
function cacheSet(key, value) {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Construye el rango de fechas actual + anterior según el preset ──
function resolveDateRanges(rangeParam, fromParam, toParam) {
  const presets = {
    today: { current: ["today", "today"], previous: ["yesterday", "yesterday"] },
    yesterday: { current: ["yesterday", "yesterday"], previous: ["2daysAgo", "2daysAgo"] },
    "7d": { current: ["7daysAgo", "today"], previous: ["14daysAgo", "8daysAgo"] },
    "30d": { current: ["30daysAgo", "today"], previous: ["60daysAgo", "31daysAgo"] },
    "90d": { current: ["90daysAgo", "today"], previous: ["180daysAgo", "91daysAgo"] },
  };
  if (rangeParam === "custom" && fromParam && toParam) {
    // Para rango personalizado no calculamos "anterior" automáticamente
    // (requeriría conocer la duración exacta en días calendario del usuario).
    return { current: [fromParam, toParam], previous: null };
  }
  const preset = presets[rangeParam] || presets["30d"];
  return { current: preset.current, previous: preset.previous };
}

// ── Construye un dimensionFilter combinando los filtros activos ──
function buildFilterExpr(filters, dimensionMap) {
  const expressions = [];
  for (const [filterKey, gaField] of Object.entries(dimensionMap)) {
    const value = filters[filterKey];
    if (value) {
      expressions.push({
        filter: { fieldName: gaField, stringFilter: { matchType: "EXACT", value } },
      });
    }
  }
  if (!expressions.length) return undefined;
  if (expressions.length === 1) return expressions[0];
  return { andGroup: { expressions } };
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  // ── Auth: acepta la contraseña de admin, o la contraseña dedicada del dashboard ──
  const authHeader = event.headers?.authorization || "";
  const providedPw = authHeader.replace("Bearer ", "").trim();
  const isAdmin = ADMIN_PASSWORD && providedPw === ADMIN_PASSWORD;
  const isDashboardUser = DASHBOARD_PASSWORD && providedPw === DASHBOARD_PASSWORD;
  if (!isAdmin && !isDashboardUser) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "No autorizado" }) };
  }

  if (!ga4.isConfigured()) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        configured: false,
        reason: "Faltan GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_EMAIL o GA4_SERVICE_ACCOUNT_PRIVATE_KEY",
      }),
    };
  }

  const qs = event.queryStringParameters || {};
  const rangeParam = qs.range || "30d";
  const { current, previous } = resolveDateRanges(rangeParam, qs.from, qs.to);

  const filters = {
    source: qs.source || "",
    medium: qs.medium || "",
    campaign: qs.campaign || "",
    country: qs.country || "",
    device: qs.device || "",
  };

  const cacheKey = JSON.stringify({ rangeParam, from: qs.from, to: qs.to, filters });
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { statusCode: 200, headers: { ...headers, "X-Cache": "HIT" }, body: JSON.stringify(cached) };
  }

  const trafficFilterMap = {
    source: "sessionSource",
    medium: "sessionMedium",
    campaign: "sessionCampaignName",
    country: "country",
    device: "deviceCategory",
  };
  const trafficFilter = buildFilterExpr(filters, trafficFilterMap);

  const dateRangesForCompare = previous
    ? [
        { startDate: current[0], endDate: current[1] },
        { startDate: previous[0], endDate: previous[1] },
      ]
    : [{ startDate: current[0], endDate: current[1] }];

  try {
    const queries = {
      // 1) Resumen + comparación (sessions, users, engagement, revenue)
      overview: {
        dateRanges: dateRangesForCompare,
        metrics: [
          { name: "sessions" }, { name: "totalUsers" }, { name: "newUsers" },
          { name: "engagedSessions" }, { name: "engagementRate" },
          { name: "averageSessionDuration" }, { name: "purchaseRevenue" },
        ],
        ...(trafficFilter ? { dimensionFilter: trafficFilter } : {}),
      },
      // 2) Embudo/recorrido: usuarios únicos por evento clave + comparación
      // (incluye search_destination y view_destination — FASE 2)
      funnel: {
        dateRanges: dateRangesForCompare,
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "totalUsers" }],
        dimensionFilter: trafficFilter
          ? { andGroup: { expressions: [trafficFilter, { filter: { fieldName: "eventName", inListFilter: { values: JOURNEY_EVENTS } } }] } }
          : { filter: { fieldName: "eventName", inListFilter: { values: JOURNEY_EVENTS } } },
      },
      // FASE 2 — Checkout: begin_checkout, cancelado, fallido, error, compra
      checkoutFunnel: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "totalUsers" }],
        dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: CHECKOUT_EVENTS } } },
      },
      // 3) Tráfico por fuente/medio/campaña
      traffic: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }, { name: "sessionCampaignName" }],
        metrics: [
          { name: "sessions" }, { name: "totalUsers" }, { name: "newUsers" },
          { name: "engagedSessions" }, { name: "engagementRate" },
          { name: "averageSessionDuration" }, { name: "purchaseRevenue" },
        ],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 25,
        ...(trafficFilter ? { dimensionFilter: trafficFilter } : {}),
      },
      // 4) Dispositivo (para insight mobile vs desktop)
      deviceSessions: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "deviceCategory" }],
        metrics: [{ name: "sessions" }],
      },
      // FASE 2 — extiende a view_item/begin_checkout/purchase por dispositivo
      // (antes solo teníamos purchase; sección 13 pide Product Views/Checkout también)
      deviceFunnel: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "deviceCategory" }, { name: "eventName" }],
        metrics: [{ name: "eventCount" }],
        dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["view_item", "begin_checkout", "purchase"] } } },
      },
      // 5) País
      countries: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "country" }],
        metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "purchaseRevenue" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 15,
      },
      // 6) Campañas x embudo
      campaignFunnel: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "sessionCampaignName" }, { name: "sessionSource" }, { name: "sessionMedium" }, { name: "eventName" }],
        metrics: [{ name: "eventCount" }, { name: "totalUsers" }, { name: "purchaseRevenue" }],
        dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: [...FUNNEL_EVENTS, "session_start"] } } },
        limit: 100,
      },
      // 7) Productos/planes (métricas item-scoped estándar de GA4 ecommerce)
      products: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "itemName" }],
        metrics: [
          { name: "itemsViewed" }, { name: "itemsAddedToCart" },
          { name: "itemsCheckedOut" }, { name: "itemsPurchased" }, { name: "itemRevenue" },
        ],
        orderBys: [{ metric: { metricName: "itemsViewed" }, desc: true }],
        limit: 25,
      },
      // 8) Destinos (requiere Custom Dimension "destination" registrada en GA4 —
      //    ver documentación. Si no está registrada, GA4 devuelve error o vacío
      //    y esta sección se muestra como no disponible sin romper el resto).
      //    FASE 2 fix: se agregó "view_destination" al filtro — antes faltaba
      //    y el procesamiento nunca podía contar vistas de destino.
      destinations: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "customEvent:destination" }, { name: "eventName" }],
        metrics: [{ name: "eventCount" }, { name: "purchaseRevenue" }],
        dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["view_destination", ...FUNNEL_EVENTS] } } },
        limit: 200,
      },
      // FASE 2 — búsquedas por término (requiere Custom Dimension "search_term"
      // registrada en GA4 — opcional, ver documentación). Se usa para estimar
      // "Searches" por destino mediante coincidencia aproximada de texto.
      searchTerms: {
        dateRanges: [{ startDate: current[0], endDate: current[1] }],
        dimensions: [{ name: "customEvent:search_term" }],
        metrics: [{ name: "eventCount" }],
        limit: 200,
      },
    };

    const results = await ga4.runReportsBatch(queries);

    // ── Diagnóstico: recopilar errores reales de CUALQUIER consulta que haya
    // fallado, en vez de dejar que se conviertan silenciosamente en ceros/vacíos.
    const queryErrors = {};
    Object.keys(results).forEach((name) => {
      if (results[name] && results[name].ok === false) {
        queryErrors[name] = results[name].error;
      }
    });
    if (queryErrors.overview || queryErrors.funnel) {
      console.error("[dashboard-api] Fallo en consulta crítica:", JSON.stringify(queryErrors));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: false,
          configured: true,
          error: "Las consultas principales de GA4 (resumen/embudo) fallaron. Detalle: " +
            (queryErrors.overview || queryErrors.funnel),
          queryErrors,
        }),
      };
    }

    // ── Normalizar y separar current/previous donde aplica ──
    const overviewRows = normalizeReport(results.overview);
    const ovCurrent = overviewRows.find(r => r.dateRange === "date_range_0") || {};
    const ovPrevious = overviewRows.find(r => r.dateRange === "date_range_1") || {};

    const funnelRows = normalizeReport(results.funnel);
    const countsCurrent = { sessions: Number(ovCurrent.sessions) || 0 };
    const countsPrevious = { sessions: Number(ovPrevious.sessions) || 0 };
    JOURNEY_EVENTS.forEach(evt => { countsCurrent[evt] = 0; countsPrevious[evt] = 0; });
    funnelRows.forEach(row => {
      const isCurrent = row.dateRange === "date_range_0";
      const target = isCurrent ? countsCurrent : countsPrevious;
      if (JOURNEY_EVENTS.includes(row.eventName)) target[row.eventName] = row.totalUsers || 0;
    });

    // Embudo original (6 pasos, ya existente — se mantiene igual)
    const funnelCurrent = computeFunnel(countsCurrent);
    const funnelPrevious = previous ? computeFunnel(countsPrevious) : null;
    const dropOff = computeDropOff(funnelCurrent, funnelPrevious);

    // FASE 2 — recorrido completo (8 pasos, incluye exploración del catálogo)
    const journeyCurrent = computeFunnel(countsCurrent, JOURNEY_STEPS);
    const journeyPrevious = previous ? computeFunnel(countsPrevious, JOURNEY_STEPS) : null;

    // FASE 2 — Checkout analytics (distingue abandono de fallo de pago)
    const checkoutRows = normalizeReport(results.checkoutFunnel);
    const checkoutCounts = { begin_checkout: 0, payment_cancelled: 0, payment_failed: 0, checkout_error: 0, purchase: 0 };
    checkoutRows.forEach(row => {
      if (CHECKOUT_EVENTS.includes(row.eventName)) checkoutCounts[row.eventName] = row.totalUsers || 0;
    });
    const checkoutAnalytics = computeCheckoutAnalytics(checkoutCounts);

    // ── Tráfico por canal ──
    const trafficRows = normalizeReport(results.traffic).map(r => ({
      source: r.sessionSource, medium: r.sessionMedium, campaign: r.sessionCampaignName,
      channel: classifyChannel(r.sessionSource, r.sessionMedium),
      sessions: r.sessions || 0, users: r.totalUsers || 0, newUsers: r.newUsers || 0,
      engagedSessions: r.engagedSessions || 0,
      engagementRate: r.engagementRate ? Math.round(r.engagementRate * 1000) / 10 : 0,
      avgSessionDuration: r.averageSessionDuration ? Math.round(r.averageSessionDuration) : 0,
      revenue: r.purchaseRevenue || 0,
    }));

    // ── Dispositivo (merge sessions + view_item/begin_checkout/purchase) ──
    const devSessions = normalizeReport(results.deviceSessions);
    const devFunnelRows = normalizeReport(results.deviceFunnel);
    const deviceBreakdown = devSessions.map(d => {
      const rowsForDevice = devFunnelRows.filter(x => x.deviceCategory === d.deviceCategory);
      const getCount = (evt) => rowsForDevice.find(r => r.eventName === evt)?.eventCount || 0;
      const sessions = d.sessions || 0;
      const purchases = getCount("purchase");
      return {
        device: d.deviceCategory,
        sessions,
        product_views: getCount("view_item"),
        checkout: getCount("begin_checkout"),
        purchases,
        conversion_rate_pct: sessions > 0 ? Math.round((purchases / sessions) * 1000) / 10 : 0,
      };
    });

    // ── País ──
    const countryBreakdown = normalizeReport(results.countries).map(r => ({
      country: r.country, sessions: r.sessions || 0, users: r.totalUsers || 0, revenue: r.purchaseRevenue || 0,
    }));

    // ── Campañas x embudo (pivot) ──
    const campaignRaw = normalizeReport(results.campaignFunnel);
    const campaignMap = new Map();
    campaignRaw.forEach(row => {
      const key = `${row.sessionCampaignName}|${row.sessionSource}|${row.sessionMedium}`;
      if (!campaignMap.has(key)) {
        campaignMap.set(key, {
          campaign: row.sessionCampaignName, source: row.sessionSource, medium: row.sessionMedium,
          sessions: 0, view_item: 0, select_plan: 0, add_to_cart: 0, begin_checkout: 0, purchases: 0, revenue: 0,
        });
      }
      const c = campaignMap.get(key);
      if (row.eventName === "session_start") c.sessions += row.eventCount || 0;
      else if (row.eventName === "purchase") { c.purchases += row.eventCount || 0; c.revenue += row.purchaseRevenue || 0; }
      else if (FUNNEL_EVENTS.includes(row.eventName)) c[row.eventName] = (c[row.eventName] || 0) + (row.eventCount || 0);
    });
    const campaigns = [...campaignMap.values()]
      .map(c => ({ ...c, conversion_rate: c.sessions > 0 ? Math.round((c.purchases / c.sessions) * 1000) / 10 : 0 }))
      .sort((a, b) => b.sessions - a.sessions);

    // ── Productos/planes (item-scoped) ──
    const products = normalizeReport(results.products).map(r => ({
      plan_name: r.itemName,
      views: r.itemsViewed || 0,
      added_to_cart: r.itemsAddedToCart || 0,
      checked_out: r.itemsCheckedOut || 0,
      purchases: r.itemsPurchased || 0,
      revenue: r.itemRevenue || 0,
      conversion_rate: r.itemsViewed > 0 ? Math.round(((r.itemsPurchased || 0) / r.itemsViewed) * 1000) / 10 : 0,
    }));

    // ── Destinos (requiere Custom Dimension registrada — ver docs) ──
    const destResult = results.destinations;
    let destinations = [];
    let destinationsAvailable = destResult.ok;
    if (destResult.ok) {
      const destRaw = normalizeReport(destResult);
      const destMap = new Map();
      destRaw.forEach(row => {
        const dest = row["customEvent:destination"] || "(sin destino)";
        if (!destMap.has(dest)) destMap.set(dest, { destination: dest, searches: 0, views: 0, selections: 0, add_to_cart: 0, checkout: 0, purchases: 0, revenue: 0 });
        const d = destMap.get(dest);
        if (row.eventName === "view_destination" || row.eventName === "view_item") d.views += row.eventCount || 0;
        if (row.eventName === "select_plan") d.selections += row.eventCount || 0;
        if (row.eventName === "add_to_cart") d.add_to_cart += row.eventCount || 0;
        if (row.eventName === "begin_checkout") d.checkout += row.eventCount || 0;
        if (row.eventName === "purchase") { d.purchases += row.eventCount || 0; d.revenue += row.purchaseRevenue || 0; }
      });

      // FASE 2 — estimar "Searches" por destino a partir de search_term (texto
      // libre). Coincidencia aproximada (no exacta): un término de búsqueda
      // cuenta para un destino si contiene su nombre o viceversa, sin distinguir
      // mayúsculas/acentos. Es una aproximación — documentada en el README.
      const searchResult = results.searchTerms;
      if (searchResult.ok) {
        const searchRaw = normalizeReport(searchResult);
        const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        destMap.forEach((d) => {
          const destNorm = norm(d.destination);
          searchRaw.forEach((row) => {
            const term = row["customEvent:search_term"] || "";
            const termNorm = norm(term);
            if (termNorm && destNorm && (destNorm.includes(termNorm) || termNorm.includes(destNorm))) {
              d.searches += row.eventCount || 0;
            }
          });
        });
      }

      destinations = flagDestinations([...destMap.values()]).sort((a, b) => b.views - a.views);
    }

    // ── KPIs de ecommerce ──
    const purchasesCurrent = countsCurrent.purchase;
    const purchasesPrevious = countsPrevious.purchase;
    const revenueCurrent = Number(ovCurrent.purchaseRevenue) || 0;
    const revenuePrevious = Number(ovPrevious.purchaseRevenue) || 0;

    const sessionsVariation = previous ? periodVariation(countsCurrent.sessions, countsPrevious.sessions) : null;
    const purchasesVariation = previous ? periodVariation(purchasesCurrent, purchasesPrevious) : null;
    const revenueVariation = previous ? periodVariation(revenueCurrent, revenuePrevious) : null;

    const insights = computeInsights({
      funnelCurrent, funnelPrevious, sessionsVariation, purchasesVariation,
      campaigns, destinations, deviceBreakdown,
      journeyFunnel: journeyCurrent, checkoutAnalytics,
    });

    const diagnostics = computeDiagnostics({
      dropOff, destinations, products, checkoutAnalytics, deviceBreakdown,
    });

    // ── Meta Ads (opcional) — combina gasto real con ingresos/compras de GA4 ──
    let metaAdsData = {
      connected: false,
      message: "Meta Ads aún no está conectado. Configura META_AD_ACCOUNT_ID y META_MARKETING_API_TOKEN para ver Ad Spend, CPA, CAC y ROAS aquí.",
    };
    if (metaAds.isConfigured()) {
      try {
        const [accountInsights, campaignInsights] = await Promise.all([
          metaAds.getAccountInsights(current[0], current[1]),
          metaAds.getCampaignInsights(current[0], current[1]),
        ]);
        const computed = computeMetaAdsMetrics(accountInsights.spend, purchasesCurrent, revenueCurrent);
        metaAdsData = {
          connected: true,
          spend: computed.spend,
          impressions: accountInsights.impressions,
          reach: accountInsights.reach,
          clicks: accountInsights.clicks,
          ctr: accountInsights.ctr,
          cpc: accountInsights.cpc,
          cpm: accountInsights.cpm,
          cpa: computed.cpa,
          cac: computed.cac,
          roas: computed.roas,
          campaigns: campaignInsights,
        };
      } catch (metaErr) {
        console.error("[dashboard-api] Meta Ads error:", metaErr.message);
        metaAdsData = { connected: false, error: true, message: `Error consultando Meta Ads: ${metaErr.message}` };
      }
    }

    const responseBody = {
      ok: true,
      configured: true,
      range: rangeParam,
      dates: { current, previous },
      kpis: {
        sessions: { value: countsCurrent.sessions, variation: sessionsVariation },
        users: { value: Number(ovCurrent.totalUsers) || 0, variation: previous ? periodVariation(Number(ovCurrent.totalUsers) || 0, Number(ovPrevious.totalUsers) || 0) : null },
        newUsers: { value: Number(ovCurrent.newUsers) || 0 },
        engagedSessions: { value: Number(ovCurrent.engagedSessions) || 0 },
        engagementRate: { value: ovCurrent.engagementRate ? Math.round(ovCurrent.engagementRate * 1000) / 10 : 0 },
        avgEngagementTimeSec: { value: ovCurrent.averageSessionDuration ? Math.round(ovCurrent.averageSessionDuration) : 0 },
        purchases: { value: purchasesCurrent, variation: purchasesVariation },
        revenue: { value: Math.round(revenueCurrent * 100) / 100, variation: revenueVariation },
        aov: { value: computeAOV(revenueCurrent, purchasesCurrent) },
        conversionRate: { value: countsCurrent.sessions > 0 ? Math.round((purchasesCurrent / countsCurrent.sessions) * 1000) / 10 : 0 },
      },
      meta_ads: metaAdsData,
      funnel: funnelCurrent,
      journey: journeyCurrent,
      journeyPrevious,
      dropOff,
      checkoutAnalytics,
      diagnostics,
      traffic: trafficRows,
      deviceBreakdown,
      countryBreakdown,
      campaigns,
      products,
      destinations,
      destinationsAvailable,
      insights,
      filtersApplied: filters,
      queryErrors: (() => {
        // "destinations" y "searchTerms" dependen de Custom Dimensions
        // opcionales que documentamos como "pueden no estar registradas
        // todavía" — su ausencia ya se comunica con destinationsAvailable
        // y con la columna "Búsquedas" en 0, así que no hace falta
        // repetirlo como una "advertencia" genérica que alarme sin razón.
        const EXPECTED_OPTIONAL = ["destinations", "searchTerms"];
        const relevant = Object.fromEntries(
          Object.entries(queryErrors).filter(([k]) => !EXPECTED_OPTIONAL.includes(k))
        );
        return Object.keys(relevant).length ? relevant : null;
      })(),
    };

    cacheSet(cacheKey, responseBody);

    return { statusCode: 200, headers: { ...headers, "X-Cache": "MISS" }, body: JSON.stringify(responseBody) };
  } catch (err) {
    console.error("[dashboard-api]", err.message);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: false, configured: true, error: err.message }),
    };
  }
};
