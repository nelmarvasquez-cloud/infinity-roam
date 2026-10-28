// ============================================================
//  NORMALIZE.JS — Capa 2: normalización de respuestas de GA4
//  Convierte el formato crudo de la API (dimensionValues/metricValues
//  por índice posicional) en objetos JS legibles y seguros.
// ============================================================

// Convierte un reporte GA4 { dimensionHeaders, metricHeaders, rows } en un
// array de objetos planos: [{ dimName: value, metricName: number }, ...]
function normalizeReport(rawResult) {
  if (!rawResult || rawResult.ok === false) return [];
  const report = rawResult.data || rawResult;
  const dimHeaders = (report.dimensionHeaders || []).map(h => h.name);
  const metHeaders = (report.metricHeaders || []).map(h => h.name);
  const rows = report.rows || [];

  return rows.map(row => {
    const obj = {};
    (row.dimensionValues || []).forEach((v, i) => { obj[dimHeaders[i]] = v.value; });
    (row.metricValues || []).forEach((v, i) => {
      const num = Number(v.value);
      obj[metHeaders[i]] = Number.isFinite(num) ? num : v.value;
    });
    return obj;
  });
}

// Extrae un único valor de un reporte sin dimensiones (solo métricas totales)
function normalizeSingleRow(rawResult, metricNames) {
  const rows = normalizeReport(rawResult);
  const row = rows[0] || {};
  const out = {};
  metricNames.forEach(m => { out[m] = Number(row[m]) || 0; });
  return out;
}

// Agrupa un array normalizado por una dimensión, sumando/mapeando métricas
function groupBy(rows, dimensionKey) {
  const map = new Map();
  for (const row of rows) {
    const key = row[dimensionKey] ?? "(not set)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

// Clasifica source/medium en un canal legible (Meta Ads, Instagram Organic, etc.)
// Basado en las convenciones estándar de UTM + defaults de GA4.
function classifyChannel(source, medium) {
  const s = (source || "").toLowerCase();
  const m = (medium || "").toLowerCase();
  const isMetaSource = s === "fb" || s === "ig" || s.includes("facebook") || s.includes("instagram");
  const isPaidMedium = ["paid_social", "paid", "cpc", "ppc"].includes(m);

  if (isMetaSource && isPaidMedium) {
    return "Meta Ads";
  }
  if ((s === "instagram" || s === "ig") && (m === "social" || m === "organic" || m === "(none)")) {
    return "Instagram Organic";
  }
  if (s === "facebook" && (m === "social" || m === "organic" || m === "(none)")) {
    return "Facebook Organic";
  }
  if (s === "google" && m === "organic") return "Google Organic";
  if (s === "google" && (m === "cpc" || m === "paid")) return "Google Ads";
  if (m === "(none)" && s === "(direct)") return "Direct";
  if (m === "referral") return "Referral";
  if (m === "email") return "Email";
  return "Otros";
}

module.exports = { normalizeReport, normalizeSingleRow, groupBy, classifyChannel };
