// ============================================================
//  PRICING.JS — Cálculo de precios con descuento, SOLO en el servidor.
//
//  Por qué existe: el costo de cada plan (zendit_tier2.json) y los
//  parámetros de los cupones no deben llegar al navegador. Antes
//  checkout.js descargaba los costos y calculaba el descuento; ahora el
//  navegador envía (offerId, precio de lista, código) y recibe SOLO el
//  precio final.
//
//  Reglas (idénticas a las que tenía checkout.js):
//   - Piso de precio = ceil(((costo + 0.30) / (1 − 0.054)) × 100) / 100
//     (tarifa real de PayPal 5.40 % + 0.30). Ningún descuento baja de ahí
//     ni sube del precio de lista.
//   - Si no se conoce el costo del plan, NO hay descuento (fail-closed).
// ============================================================

const TIER2 = require("../../../zendit_tier2.json");      // costo por offerId (no se publica)
const SUGGESTED = require("../../../zendit_prices.json"); // precio sugerido por offerId

const PAYPAL_REAL_PCT = 0.054;
const PAYPAL_REAL_FIXED = 0.30;
const REFERRAL_DISCOUNT = 0.05;
const MAX_LIST_PRICE = 10000; // tope de cordura para el precio de lista recibido

function costOf(offerId) {
  if (!offerId || !Object.prototype.hasOwnProperty.call(TIER2, offerId)) return null;
  const raw = TIER2[offerId];
  const cost = Number(Array.isArray(raw) ? raw[0] : raw);
  return cost > 0 ? cost : null;
}

function minSafePrice(offerId) {
  const cost = costOf(offerId);
  if (cost === null) return null;
  return Math.ceil(((cost + PAYPAL_REAL_FIXED) / (1 - PAYPAL_REAL_PCT)) * 100) / 100;
}

function applyPriceFloor(listPrice, discounted, offerId) {
  const floor = minSafePrice(offerId);
  if (floor === null) return listPrice; // costo desconocido → sin descuento
  return Math.min(listPrice, Math.max(discounted, floor));
}

// Precio con descuento ANTES del piso, según el tipo de cupón.
function rawCouponPrice(listPrice, coupon, offerId) {
  const cost = costOf(offerId);
  if (cost === null) return listPrice;

  if (coupon.type === "breakeven_tier2") {
    return Math.ceil((cost / (1 - coupon.paypalFee)) * 100) / 100;
  }
  if (coupon.type === "pioneer_tier2") {
    const fee = coupon.paypalFee;
    const breakeven = cost / (1 - fee);
    const sug = Number(Object.prototype.hasOwnProperty.call(SUGGESTED, offerId) ? SUGGESTED[offerId] : 0) || listPrice;
    const profitSuggested = sug * (1 - fee) - cost;
    const pioneer = breakeven + coupon.profitShare * Math.max(profitSuggested, 0);
    return Math.min(Math.ceil(pioneer * 100) / 100, listPrice);
  }
  if (coupon.type === "percent") {
    return listPrice * (1 - coupon.discount / 100);
  }
  return listPrice;
}

// Precio final (por unidad) con un cupón interno. Redondeado a centavos.
function couponPrice(listPrice, coupon, offerId) {
  return round2(applyPriceFloor(listPrice, rawCouponPrice(listPrice, coupon, offerId), offerId));
}

// Precio final (por unidad) con código de referido (5 %).
function referralPrice(listPrice, offerId) {
  const discounted = Math.round(listPrice * (1 - REFERRAL_DISCOUNT) * 100) / 100;
  return round2(applyPriceFloor(listPrice, discounted, offerId));
}

function round2(n) { return Math.round(n * 100) / 100; }

// Valida el plan que pide el navegador. El precio de LISTA lo fija el servidor
// (el mismo que muestra el catálogo): el precio que mande el navegador se ignora.
// Así nadie puede "sondear" el piso de precio (y por tanto el costo) probando
// precios de lista inventados con un código válido.
// Devuelve { offerId, listPrice } o null si el plan no existe.
function parseQuote(body) {
  const offerId = String((body && body.offerId) || "");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(offerId)) return null;
  const listPrice = listPriceOf(offerId);
  if (!(listPrice > 0) || listPrice > MAX_LIST_PRICE) return null;
  return { offerId, listPrice };
}

// Precio de venta (lista) de un plan: sugerido de Zendit; si no existe, costo × markup.
function listPriceOf(offerId, markup = 1.5) {
  const s = Object.prototype.hasOwnProperty.call(SUGGESTED, offerId) ? Number(SUGGESTED[offerId]) : 0;
  if (s > 0) return round2(s);
  const cost = costOf(offerId);
  return cost === null ? 0 : Number(((Math.round(cost * 100) / 100) * markup).toFixed(2));
}

module.exports = { costOf, minSafePrice, couponPrice, referralPrice, parseQuote, listPriceOf, REFERRAL_DISCOUNT };
